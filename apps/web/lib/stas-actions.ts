'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { planMint } from '@launchpad/bsv/issue';
import { operatorDeliverStas } from '@launchpad/bsv/settle';
import { buildStasSellRefundTx } from '@launchpad/curve';
import { isProjectOwner } from './account-actions';
import { getOperator, getOperatorWallet, operatorSignDigest } from './operator-wallet';
import { stasGenesisScript } from './stas-service';
import { resolveCurrentPool, getOutputInfo, getSourceBeef, broadcastRawTx, verifyStasBackToGenesis, findStasOutputToPkh } from './settle-actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadBsv(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

/** Build the P2PKH locking-script hex for a mainnet address (the seller refund output). */
async function p2pkhScriptHexForAddress(address: string): Promise<string> {
  const bsv = await loadBsv();
  return bsv.Script.buildPublicKeyHashOut(bsv.Address.fromString(address)).toHex();
}

/** Exact linear-curve cost to move `sold` by delta (mirrors StasCurvePool.buy). */
function curveCost(k: bigint, sold: bigint, delta: bigint): bigint {
  return (k * delta * (2n * sold + delta + 1n)) / 2n;
}

/**
 * Option-B "stas" bonding-curve server actions (ADR-028). The on-chain state is split:
 *   - a small SAT reserve covenant (StasCurvePool) whose value is the reserve and whose
 *     script carries `sold` — deployed + seeded by the project owner's wallet;
 *   - the full token supply issued as REAL STAS into the operator vault, from which the
 *     operator delivers tokens to buyers on each buy.
 * The operator never holds the owner's keys; these actions persist the covenant's on-chain
 * outpoint + the minted inventory so trades can be sequenced against the latest state (BSV
 * has no global mutable state). Deploy and mint are TWO independent signed txs, each modelled
 * as a prepare/record split mirroring curve-actions / ledger-actions and the issuance flow —
 * nothing here broadcasts; the client wallet signs, then records.
 */

// Phase-1 curve params for the stas variant. Baked into the reserve covenant at genesis
// (k = price slope, supply = max tokens the curve sells). Mirrors the ledger variant's
// hardcoded params; the full `supply` is minted as STAS into the operator vault.
const STAS_K = 1n;
const STAS_SUPPLY = 1000n;

/**
 * Owner-gated: create/refresh the stas CurvePool row (draft) + return the genesis reserve-
 * covenant script the owner's wallet deploys (a createAction output of `seedReserveSats`
 * locked to this script). Mirrors createLedgerPool.
 */
export async function createStasPool(input: { saleId: string; identityPubkey: string; seedReserveSats: number }): Promise<{ ok: boolean; scriptHex?: string; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (input.seedReserveSats < 1) return { ok: false, error: 'seed reserve must be positive' };
    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing && existing.status === 'live') return { ok: false, error: 'pool already live' };

    const { pkh: operatorPkh } = await getOperator();
    const scriptHex = await stasGenesisScript(STAS_K, STAS_SUPPLY, operatorPkh);
    await prisma.curvePool.upsert({
      where: { saleId: input.saleId },
      create: { saleId: input.saleId, variant: 'stas', k: STAS_K, supply: STAS_SUPPLY, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), operatorPkh, status: 'draft' },
      update: { variant: 'stas', seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), operatorPkh },
    });
    return { ok: true, scriptHex };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Owner-gated: record the deployed reserve-covenant UTXO (draft -> live). Mirrors
 * markCurvePoolDeployed. The client broadcasts the deploy tx, then calls this.
 */
export async function markStasPoolDeployed(input: {
  saleId: string; identityPubkey: string; txid: string; vout: number; scriptHex: string; reserveSats: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) return { ok: false, error: 'invalid deploy txid' };
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };

    await prisma.curvePool.update({
      where: { saleId: input.saleId },
      data: {
        poolTxid: input.txid,
        poolVout: input.vout,
        scriptHex: input.scriptHex,
        reserveSats: BigInt(Math.floor(input.reserveSats)),
        sold: 0n,
        status: 'live',
      },
    });
    await prisma.sale.update({ where: { id: input.saleId }, data: { status: 'live' } });
    await prisma.event.create({ data: { entity: 'CurvePool', entityId: input.saleId, type: 'stas_pool_deployed' } });
    revalidatePath(`/sale/${sale.token.project.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Owner-gated: build the mint plan for issuing the full curve `supply` as ONE STAS
 * issuance DELIVERED TO THE OPERATOR VAULT (the owner = operator, so the STAS output
 * locks to hash160(operator pubkey) = the vault). Mirrors buildMintPlan: the client
 * passes its wallet-derived REDEMPTION pubkey (the provenance anchor / tokenId); nothing
 * here touches a private key. The client then runs the CONTRACT -> ISSUE genesis passing the
 * returned `ownerPubHex` as issueStasGenesis's owner override (so the STAS locks to the operator
 * vault, NOT the signing wallet's `${slug}-owner`), broadcasts, and calls recordStasMint. The
 * returned `ownerPubHex` is the operator's public key from getOperator(); `tokenId` stays anchored
 * to the client's wallet-derived `${slug}-redeem` key, so the client MUST issue under the same slug.
 */
export async function prepareStasMint(input: { saleId: string; identityPubkey: string; redemptionPubkey: string }): Promise<
  | { ok: true; symbol: string; supply: number; tokenSatoshis: number; tokenId: string; ownerAddress: string; ownerPkh: string; ownerPubHex: string; stasScriptHex: string; estFeeSats: number; totalSatsRequired: number }
  | { ok: false; error: string }
> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };

    const symbol = sale.token.ticker.replace(/^\$/, '');
    const supply = Number(pool.supply);
    const { pubHex: operatorPubHex } = await getOperator();
    // owner = operator vault (STAS locks to the operator's pkh); redemption = wallet anchor.
    // The client passes ownerPubHex to issueStasGenesis's owner override so the on-chain
    // STAS output matches this plan's ownerPkh/stasScriptHex exactly.
    const plan = planMint({ symbol, supply }, operatorPubHex, input.redemptionPubkey);
    return { ok: true, ...plan, ownerPubHex: operatorPubHex };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Owner-gated: record the completed STAS inventory mint (the CONTRACT -> ISSUE genesis the
 * client broadcast). Persists the tokenId + issuance txid on the Token (the on-chain
 * signature is the real authority; this is bookkeeping over a committed fact). Mirrors
 * recordIssuance but does NOT flip sale status — the reserve deploy handles that.
 */
export async function recordStasMint(input: { saleId: string; identityPubkey: string; issuanceTxid: string; tokenId: string }): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.issuanceTxid)) return { ok: false, error: 'invalid issuance txid' };
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };

    await prisma.token.update({
      where: { id: sale.token.id },
      data: { issuanceTxid: input.issuanceTxid, stasTokenId: input.tokenId },
    });
    await prisma.event.create({ data: { entity: 'Token', entityId: sale.token.id, type: 'stas_inventory_minted', payloadHash: input.issuanceTxid } });
    revalidatePath(`/sale/${sale.token.project.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Current stas pool state + derived curve info + minted inventory reference (for building a
 * buy/sell client-side later). Mirrors getLedgerPool / getCurvePoolState.
 */
export async function getStasPool(saleId: string): Promise<
  | { ok: true; poolTxid: string; poolVout: number; scriptHex: string; reserveSats: number; seedReserveSats: number; sold: number; k: string; supply: string; operatorPkh: string; stasTokenId: string | null; issuanceTxid: string | null }
  | { ok: false; error: string }
> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId }, include: { sale: { include: { token: true } } } });
    if (!p || p.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex || !p.operatorPkh) return { ok: false, error: 'pool is not live yet' };
    return {
      ok: true,
      poolTxid: p.poolTxid, poolVout: p.poolVout, scriptHex: p.scriptHex,
      reserveSats: Number(p.reserveSats), seedReserveSats: Number(p.seedReserveSats), sold: Number(p.sold),
      k: p.k.toString(), supply: p.supply.toString(), operatorPkh: p.operatorPkh,
      stasTokenId: p.sale.token.stasTokenId, issuanceTxid: p.sale.token.issuanceTxid,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 · BUY (ADR-028). A stas buy is TWO sequenced txs:
//   TX-A "reserve buy" (buyer-signed, client-assembled via curve/buildStasBuyTx):
//        buyer pays `cost` into the reserve, sold += delta.  recorded by recordStasBuy.
//   TX-B "STAS delivery" (operator-signed, backend): deliverStasToBuyer transfers
//        `delta` STAS from the operator vault to the buyer's receive address.
// Sequencing mirrors recordCurveBuy exactly: buys build against the LATEST pool
// outpoint; the record step advances the pool ONLY if it still sits there
// (optimistic guard) so a raced buy can't corrupt tracked state. The single pool
// UTXO is inherently serial, so this outpoint guard IS the concurrency control —
// no separate DB reservation (kept faithful to recordCurveBuy).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sequence a stas reserve buy against the LATEST StasCurvePool outpoint and return
 * the current pool state + exact curve `cost` for the buyer to assemble TX-A
 * (buildStasBuyTx funds + signs its own SIGHASH_ALL payment). This is the
 * sequencing anchor — the buyer builds against exactly this outpoint and passes it
 * back to recordStasBuy, whose optimistic guard rejects a stale (raced) advance.
 */
export async function prepareStasBuy(input: { saleId: string; buyerIdentity: string; delta: number }): Promise<
  | { ok: true; pool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number; k: number; supply: number }; cost: number; delta: number }
  | { ok: false; error: string }
> {
  try {
    if (!Number.isInteger(input.delta) || input.delta <= 0) return { ok: false, error: 'delta must be a positive integer' };
    const p = await prisma.curvePool.findUnique({ where: { saleId: input.saleId }, include: { sale: { include: { token: true } } } });
    if (!p || p.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex) return { ok: false, error: 'pool is not live yet' };
    if (!p.sale.token.issuanceTxid) return { ok: false, error: 'inventory not minted yet — no vault to deliver from' };
    const sold = Number(p.sold);
    const supply = Number(p.supply);
    if (sold + input.delta > supply) return { ok: false, error: 'exceeds curve supply' };
    const cost = Number(curveCost(p.k, p.sold, BigInt(input.delta)));
    return {
      ok: true,
      pool: { txid: p.poolTxid, vout: p.poolVout, scriptHex: p.scriptHex, reserveSats: Number(p.reserveSats), sold, k: Number(p.k), supply },
      cost,
      delta: input.delta,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record a broadcast reserve buy (TX-A): advance the pool + create the buy Order.
 * Mirrors recordCurveBuy's sequencing EXACTLY (optimistic outpoint guard), with one
 * difference: the Order is left `pending` (paymentTxid = TX-A) because STAS delivery
 * is a SEPARATE operator tx (TX-B) — deliverStasToBuyer flips it to `settled` and
 * stamps the delivery `txid`. Returns the new orderId so the caller can trigger
 * delivery.
 */
export async function recordStasBuy(input: {
  saleId: string;
  buyerIdentity: string;
  receiveAddress: string; // buyer's STAS receive address (where TX-B delivers)
  spentPoolTxid: string; // the pool outpoint this buy consumed
  spentPoolVout: number;
  buyTxid: string; // TX-A
  newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number };
  delta: number;
  cost: number;
}): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.buyTxid)) return { ok: false, error: 'invalid buy txid' };
  if (!input.receiveAddress) return { ok: false, error: 'receiveAddress required' };
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
      if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) {
        return { ok: false, error: 'pool has moved — this buy raced another; rebuild against the latest outpoint' };
      }
      await tx.curvePool.update({
        where: { saleId: input.saleId },
        data: {
          poolTxid: input.newPool.txid,
          poolVout: input.newPool.vout,
          scriptHex: input.newPool.scriptHex,
          reserveSats: BigInt(Math.floor(input.newPool.reserveSats)),
          sold: BigInt(Math.floor(input.newPool.sold)),
          status: input.newPool.sold >= Number(pool.supply) ? 'graduated' : 'live',
        },
      });
      const order = await tx.order.create({
        data: {
          saleId: input.saleId,
          buyerIdentity: input.buyerIdentity,
          receiveAddress: input.receiveAddress,
          kind: 'curve_buy',
          tokens: BigInt(Math.floor(input.delta)),
          satsPaid: BigInt(Math.floor(input.cost)),
          state: 'pending', // awaiting operator STAS delivery (TX-B)
          paymentTxid: input.buyTxid,
        },
      });
      await tx.event.create({ data: { entity: 'Order', entityId: order.id, type: 'stas_reserve_bought', payloadHash: input.buyTxid } });
      return { ok: true, orderId: order.id };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * TX-B · operator STAS delivery (backend, operator-signed). Transfers `delta` STAS
 * from the operator vault to the buyer's receive address, then broadcasts. Called
 * explicitly after recordStasBuy — never at import/build time.
 *
 * Custody split (ADR-028): the STAS inventory lives at the operator's BASE P2PKH
 * vault (owner = operator flat key), while the fee sats live in the toolbox custody
 * wallet. So the token input is signed by the operator flat key (operatorSignDigest,
 * raw ECDSA) and the fee input by the toolbox wallet (getOperatorWallet). The vault
 * UTXO moves after each delivery (token-change re-locks back to the operator pkh),
 * so we RESOLVE the current vault on-chain by walking the change chain from the mint
 * (resolveCurrentPool) — the same walk settlement uses for the pool.
 */
export async function deliverStasToBuyer(input: { orderId: string }): Promise<{ ok: boolean; txid?: string; error?: string }> {
  try {
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order || order.kind !== 'curve_buy') return { ok: false, error: 'order not found or not a curve buy' };
    if (order.txid) return { ok: true, txid: order.txid }; // already delivered (idempotent)
    if (!order.receiveAddress) return { ok: false, error: 'order has no receive address' };
    const delta = Number(order.tokens);
    if (delta <= 0) return { ok: false, error: 'nothing to deliver' };

    const pool = await prisma.curvePool.findUnique({ where: { saleId: order.saleId }, include: { sale: { include: { token: { include: { project: true } } } } } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    const issuanceTxid = pool.sale.token.issuanceTxid;
    if (!issuanceTxid) return { ok: false, error: 'inventory not minted — no vault to deliver from' };

    // Claim the order (pending → settling) so a double-invoke can't build two
    // deliveries. Released back to pending on failure below.
    const claim = await prisma.order.updateMany({ where: { id: order.id, state: 'pending' }, data: { state: 'settling' } });
    if (claim.count !== 1) return { ok: false, error: `order not deliverable (state ${order.state})` };

    try {
      const { pubHex, pkh: operatorPkh } = await getOperator();

      // Resolve the CURRENT vault UTXO on-chain (it moves as tokens are delivered).
      const vault = await resolveCurrentPool(issuanceTxid);
      if ('error' in vault) throw new Error(`resolve vault: ${vault.error}`);
      const info = await getOutputInfo(vault.txid, vault.vout);
      if (!info) throw new Error('could not fetch vault UTXO script/value');
      if (info.satoshis < delta) throw new Error(`vault holds ${info.satoshis} tokens, need ${delta}`);
      const beef = await getSourceBeef(vault.txid);
      if (!beef) throw new Error('could not fetch vault ancestry BEEF (mint may still be confirming)');

      const feeWallet = await getOperatorWallet();
      const res = await operatorDeliverStas({
        feeWallet,
        chain: 'main',
        source: { txid: vault.txid, vout: vault.vout, scriptHex: info.scriptHex, satoshis: info.satoshis, beef },
        recipientAddress: order.receiveAddress,
        amount: delta,
        vaultChangeHash160: operatorPkh,
        tokenOwnerPubHex: pubHex,
        signTokenDigest: operatorSignDigest,
      });
      if (!res.ok) throw new Error(res.reason);

      // Broadcast TX1 (funding) first, then TX-B, retrying on "Missing inputs"
      // while TX1 propagates to the node.
      if (res.fundingRawTx) await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
      let bc = await broadcastRawTx(res.rawTx, res.txid);
      for (let i = 0; i < 4 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        bc = await broadcastRawTx(res.rawTx, res.txid);
      }
      if (!bc.ok) throw new Error(`delivery broadcast rejected: ${bc.error}`);

      const deliveryTxid = bc.txid || res.txid;
      await prisma.order.update({ where: { id: order.id }, data: { state: 'settled', txid: deliveryTxid } });
      await prisma.event.create({ data: { entity: 'Order', entityId: order.id, type: 'stas_delivered', payloadHash: deliveryTxid } });
      revalidatePath(`/sale/${pool.sale.token.project.slug}`);
      return { ok: true, txid: deliveryTxid };
    } catch (e) {
      // Release the claim so delivery can be retried.
      await prisma.order.updateMany({ where: { id: order.id, state: 'settling' }, data: { state: 'pending' } });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 · SELL (ADR-028). A stas sell is TWO sequenced txs (see stasSellAssembly.ts
// for WHY it is not atomic — the deployed covenant's ANYONECANPAY_ALL sell pins EXACTLY
// two outputs [successor pool, seller refund], leaving no room for the STAS-return
// output in the same tx):
//   TX1 "STAS return"  (holder-signed, client/wallet — DEFERRED UI): the holder
//        transfers `delta` STAS to the operator vault pkh (a plain wallet STAS send).
//   TX2 "reserve refund" (operator-cosigned, backend): finalizeStasSell verifies the
//        returned STAS is GENUINE (back-to-genesis), then co-signs the covenant sell to
//        pay the curve refund to the seller and advance the pool (sold -= delta).
// Ordering follows the ADR-028 step-3 fallback: the holder returns STAS FIRST, then the
// operator refunds — so the operator never pays out without receiving genuine inventory.
// The added trust vs. the (infeasible) atomic form: (a) the operator must be LIVE to
// broadcast the refund (same liveness trust as the buy's TX-B delivery); and (b) the
// operator supplies output 1, so payee-correctness relies on the operator refunding to
// the SELLER's recorded address (the covenant caps the AMOUNT but does not bind the
// payee). See DECISIONS.md ADR-028 step-3.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sequence a stas sell against the LATEST StasCurvePool outpoint and return the current
 * pool state + the operator VAULT pkh (where the holder returns `delta` STAS in TX1) +
 * the curve refund preview. Mirrors prepareStasBuy: this is the sequencing anchor — the
 * refund is FINALISED against the pool's actual `sold` at cosign time, so the preview may
 * shift if other trades land first.
 */
export async function prepareStasSell(input: { saleId: string; sellerIdentity: string; delta: number; sellerRefundAddress: string }): Promise<
  | { ok: true; pool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number; k: number; supply: number }; vaultPkh: string; refund: number; delta: number }
  | { ok: false; error: string }
> {
  try {
    if (!Number.isInteger(input.delta) || input.delta <= 0) return { ok: false, error: 'delta must be a positive integer' };
    if (!input.sellerRefundAddress) return { ok: false, error: 'sellerRefundAddress required' };
    const p = await prisma.curvePool.findUnique({ where: { saleId: input.saleId }, include: { sale: { include: { token: true } } } });
    if (!p || p.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex) return { ok: false, error: 'pool is not live yet' };
    if (!p.sale.token.issuanceTxid) return { ok: false, error: 'inventory not minted — nothing to sell back' };
    const sold = Number(p.sold);
    if (input.delta > sold) return { ok: false, error: 'sells more than the curve has outstanding' };
    // sanity: the refund address must be a valid mainnet address the covenant can pay.
    try {
      await p2pkhScriptHexForAddress(input.sellerRefundAddress);
    } catch {
      return { ok: false, error: 'invalid seller refund address' };
    }
    const refund = Number(curveCost(p.k, BigInt(sold - input.delta), BigInt(input.delta)));
    const { pkh: vaultPkh } = await getOperator();
    return {
      ok: true,
      pool: { txid: p.poolTxid, vout: p.poolVout, scriptHex: p.scriptHex, reserveSats: Number(p.reserveSats), sold, k: Number(p.k), supply: Number(p.supply) },
      vaultPkh,
      refund,
      delta: input.delta,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record a broadcast STAS return (TX1): create the `curve_sell` Order (state `pending`,
 * awaiting the operator refund). The holder has already transferred `delta` STAS to the
 * operator vault; `returnTxid` is that tx. The pool is NOT advanced here — it moves in
 * TX2 (finalizeStasSell), which is where the covenant sell actually spends the reserve.
 * Nothing here is trusted blindly: finalizeStasSell re-verifies the returned STAS
 * on-chain (amount + locked-to-vault + back-to-genesis) before refunding.
 */
export async function recordStasSell(input: {
  saleId: string;
  sellerIdentity: string;
  sellerRefundAddress: string; // where the covenant refund is paid (output 1)
  returnTxid: string; // TX1 — the holder's STAS return to the operator vault
  delta: number;
}): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.returnTxid)) return { ok: false, error: 'invalid STAS-return txid' };
  if (!input.sellerRefundAddress) return { ok: false, error: 'sellerRefundAddress required' };
  if (!Number.isInteger(input.delta) || input.delta <= 0) return { ok: false, error: 'delta must be a positive integer' };
  try {
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    if (input.delta > Number(pool.sold)) return { ok: false, error: 'sells more than the curve has outstanding' };
    const refundPreview = Number(curveCost(pool.k, BigInt(Number(pool.sold) - input.delta), BigInt(input.delta)));
    const order = await prisma.order.create({
      data: {
        saleId: input.saleId,
        buyerIdentity: input.sellerIdentity,
        receiveAddress: input.sellerRefundAddress, // covenant refund payee (output 1)
        kind: 'curve_sell',
        tokens: BigInt(Math.floor(input.delta)),
        satsPaid: BigInt(Math.floor(refundPreview)), // finalised at cosign against actual `sold`
        state: 'pending', // awaiting operator refund (TX2)
        paymentTxid: input.returnTxid, // the holder's STAS return
      },
    });
    await prisma.event.create({ data: { entity: 'Order', entityId: order.id, type: 'stas_sell_returned', payloadHash: input.returnTxid } });
    return { ok: true, orderId: order.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * TX2 · operator reserve-refund co-sign (backend). Verifies the returned STAS is genuine
 * (back-to-genesis) and exactly `delta` locked to the vault, then co-signs the covenant
 * SELL to pay the curve refund to the seller and advance the pool. Called explicitly
 * after recordStasSell — never at import/build time. The operator co-sign + broadcast
 * fire ONLY inside this server action.
 *
 * INVARIANTS enforced here: (1) back-to-genesis MUST pass before the operator co-signs —
 * no refund for counterfeit STAS; (2) the returned STAS amount == delta and is locked to
 * the operator vault; (3) the covenant caps the refund at the curve price and pins the
 * successor (the assembly module re-validates the covenant input in @bsv/sdk before
 * broadcast); (4) the pool advances only if it still sits at the outpoint the refund was
 * built against (optimistic guard, mirrors recordCurveBuy); (5) sold never underflows.
 */
export async function finalizeStasSell(input: { orderId: string }): Promise<{ ok: boolean; txid?: string; error?: string }> {
  try {
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order || order.kind !== 'curve_sell') return { ok: false, error: 'order not found or not a curve sell' };
    if (order.refundTxid) return { ok: true, txid: order.refundTxid }; // already refunded (idempotent)
    if (!order.receiveAddress) return { ok: false, error: 'order has no refund address' };
    if (!order.paymentTxid) return { ok: false, error: 'order has no STAS-return txid' };
    const delta = Number(order.tokens);
    if (delta <= 0) return { ok: false, error: 'nothing to refund' };

    const pool = await prisma.curvePool.findUnique({ where: { saleId: order.saleId }, include: { sale: { include: { token: { include: { project: true } } } } } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    if (pool.status !== 'live' || !pool.poolTxid || pool.poolVout == null || !pool.scriptHex) return { ok: false, error: 'pool is not live' };
    const issuanceTxid = pool.sale.token.issuanceTxid;
    if (!issuanceTxid) return { ok: false, error: 'inventory not minted — no genesis to verify against' };
    if (delta > Number(pool.sold)) return { ok: false, error: 'sells more than the curve has outstanding' };

    // Claim the order (pending → settling) so a double-invoke can't build two refunds.
    const claim = await prisma.order.updateMany({ where: { id: order.id, state: 'pending' }, data: { state: 'settling' } });
    if (claim.count !== 1) return { ok: false, error: `order not refundable (state ${order.state})` };

    try {
      const { pubHex, pkh: operatorPkh } = await getOperator();

      // (1) Locate the returned STAS output: exactly `delta` tokens locked to the vault.
      const returned = await findStasOutputToPkh(order.paymentTxid, operatorPkh, delta);
      if (!returned) throw new Error(`no STAS return of ${delta} to the vault found in ${order.paymentTxid.slice(0, 12)}… — refusing refund`);

      // (2) BACK-TO-GENESIS — MUST pass before co-signing. No refund for counterfeit STAS.
      const auth = await verifyStasBackToGenesis({ outpointTxid: order.paymentTxid, outpointVout: returned.vout, issuanceTxid });
      if (!auth.authentic) throw new Error(`returned STAS failed back-to-genesis (${auth.reason}) — refusing refund`);

      // (3) Build the covenant refund (TX2) against the LATEST pool outpoint. The refund
      // is the curve refund at the pool's actual `sold`; the covenant caps + pins it.
      const spentPoolTxid = pool.poolTxid;
      const spentPoolVout = pool.poolVout;
      const sellerRefundScriptHex = await p2pkhScriptHexForAddress(order.receiveAddress);
      const feeWallet = await getOperatorWallet();
      const res = await buildStasSellRefundTx({
        feeWallet,
        chain: 'main',
        pool: { txid: pool.poolTxid, vout: pool.poolVout, scriptHex: pool.scriptHex, reserveSats: Number(pool.reserveSats), sold: Number(pool.sold), k: Number(pool.k), supply: Number(pool.supply) },
        delta,
        sellerRefundScriptHex,
        operatorPubHex: pubHex,
        signCovenant: operatorSignDigest,
      });
      if (!res.ok) throw new Error(res.reason);

      // Broadcast the fee-funding tx first, then TX2, retrying on "Missing inputs" while
      // the funding propagates (mirrors deliverStasToBuyer).
      if (res.fundingRawTx) await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
      let bc = await broadcastRawTx(res.rawTx, res.txid);
      for (let i = 0; i < 4 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        bc = await broadcastRawTx(res.rawTx, res.txid);
      }
      if (!bc.ok) throw new Error(`refund broadcast rejected: ${bc.error}`);
      const refundTxid = bc.txid || res.txid;

      // (4) Advance the pool ONLY if it still sits at the outpoint we built against
      // (optimistic guard, mirrors recordCurveBuy). (5) sold -= delta (never underflows —
      // guarded above). Stamp the order settled with the refund tx.
      const done = await prisma.$transaction(async (txn) => {
        const cur = await txn.curvePool.findUnique({ where: { saleId: order.saleId } });
        if (!cur || cur.poolTxid !== spentPoolTxid || cur.poolVout !== spentPoolVout) {
          return { advanced: false as const };
        }
        await txn.curvePool.update({
          where: { saleId: order.saleId },
          data: {
            poolTxid: res.newPool.txid,
            poolVout: res.newPool.vout,
            scriptHex: res.newPool.scriptHex,
            reserveSats: BigInt(Math.floor(res.newPool.reserveSats)),
            sold: BigInt(Math.floor(res.newPool.sold)),
            status: 'live',
          },
        });
        await txn.order.update({ where: { id: order.id }, data: { state: 'settled', refundTxid, txid: refundTxid, satsPaid: BigInt(Math.floor(res.refund)) } });
        await txn.event.create({ data: { entity: 'Order', entityId: order.id, type: 'stas_sell_refunded', payloadHash: refundTxid } });
        return { advanced: true as const };
      });
      if (!done.advanced) {
        // The refund broadcast but the pool moved under us (a raced trade). The tx would
        // not have spent the current pool, so it will not confirm. Surface for the
        // operator to reconcile rather than corrupt tracked state.
        await prisma.order.updateMany({ where: { id: order.id, state: 'settling' }, data: { state: 'pending' } });
        return { ok: false, error: 'pool moved during refund — a raced trade advanced it; retry the sell' };
      }
      revalidatePath(`/sale/${pool.sale.token.project.slug}`);
      return { ok: true, txid: refundTxid };
    } catch (e) {
      // Release the claim so the refund can be retried.
      await prisma.order.updateMany({ where: { id: order.id, state: 'settling' }, data: { state: 'pending' } });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
