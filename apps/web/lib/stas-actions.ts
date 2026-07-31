'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { planMint } from '@launchpad/bsv/issue';
import { operatorDeliverStas } from '@launchpad/bsv/settle';
import { isProjectOwner } from './account-actions';
import { getOperator, getOperatorWallet, operatorSignDigest } from './operator-wallet';
import { stasGenesisScript } from './stas-service';
import { resolveCurrentPool, getOutputInfo, getSourceBeef, broadcastRawTx } from './settle-actions';

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
