'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { planMint } from '@launchpad/bsv/issue';
import { operatorDeliverStas } from '@launchpad/bsv/settle';
import { buildStasSellRefundTx } from '@launchpad/curve';
import { isProjectOwner } from './account-actions';
import { getOperator, getOperatorWallet, operatorSignDigest } from './operator-wallet';
import { stasGenesisScript } from './stas-service';
import { resolveCurrentPool, getOutputInfo, getSourceBeefDeep, broadcastRawTx, verifyStasBackToGenesis, findStasOutputToPkh, isOutputUnspent } from './settle-actions';

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

// Default curve params for the stas variant — a TINY demo pool so a full mainnet
// buy+sell round-trip is CHEAP to test (ADR-028 step-4 decision). k + supply are
// baked into the reserve covenant at genesis (k = price slope, supply = max tokens
// the curve sells) AND the whole `supply` is minted as STAS into the operator vault,
// so a large supply = a large sat lock. The owner overrides these at deploy; these
// are just the defaults. Bounded to keep a demo mint from locking real money.
const STAS_K_DEFAULT = 1n;
const STAS_SUPPLY_DEFAULT = 5n;
const STAS_SUPPLY_MAX = 1000n; // guard: don't let a typo mint a 1e6-sat vault

/**
 * Owner-gated: create/refresh the stas CurvePool row (draft) + return the genesis reserve-
 * covenant script the owner's wallet deploys (a createAction output of `seedReserveSats`
 * locked to this script). Mirrors createLedgerPool. `k` + `supply` are CONFIGURABLE at
 * deploy (default a tiny demo pool) so a mainnet round-trip is cheap — they bake into the
 * reserve covenant AND set how much STAS is minted into the vault.
 */
export async function createStasPool(input: { saleId: string; identityPubkey: string; seedReserveSats: number; k?: number; supply?: number }): Promise<{ ok: boolean; scriptHex?: string; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (input.seedReserveSats < 1) return { ok: false, error: 'seed reserve must be positive' };
    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing && existing.status === 'live') return { ok: false, error: 'pool already live' };

    const k = input.k != null && Number.isInteger(input.k) && input.k >= 1 ? BigInt(input.k) : STAS_K_DEFAULT;
    let supply = input.supply != null && Number.isInteger(input.supply) && input.supply >= 1 ? BigInt(input.supply) : STAS_SUPPLY_DEFAULT;
    if (supply > STAS_SUPPLY_MAX) supply = STAS_SUPPLY_MAX;

    const { pkh: operatorPkh } = await getOperator();
    const scriptHex = await stasGenesisScript(k, supply, operatorPkh);
    await prisma.curvePool.upsert({
      where: { saleId: input.saleId },
      create: { saleId: input.saleId, variant: 'stas', k, supply, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), operatorPkh, status: 'draft' },
      update: { variant: 'stas', k, supply, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), operatorPkh },
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

/**
 * List a seller's SPENDABLE STAS deliveries for a sale (settled curve_buy orders, each a
 * STAS output at `deliveryTxid:0` owned by the buyer) + their net held balance. The sell's
 * TX1 spends one of these deliveries: the client resolves its CURRENT unspent outpoint by
 * walking the change chain on-chain (resolveCurrentPool) — a delivery whose STAS was partly
 * sold already leaves change back to the same holder pkh. Used to seed the sell card and pick
 * a source big enough for `delta`. `held` = Σ settled buys − Σ (pending|settled) sells.
 */
export async function getSellerStasDeliveries(input: { saleId: string; sellerIdentity: string }): Promise<
  { ok: true; held: number; deliveries: { orderId: string; txid: string; tokens: number }[] } | { ok: false; error: string }
> {
  try {
    const buys = await prisma.order.findMany({
      where: { saleId: input.saleId, buyerIdentity: input.sellerIdentity, kind: 'curve_buy', state: 'settled', txid: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    const sells = await prisma.order.findMany({
      where: { saleId: input.saleId, buyerIdentity: input.sellerIdentity, kind: 'curve_sell', state: { in: ['pending', 'settling', 'settled'] } },
    });
    const bought = buys.reduce((n, o) => n + Number(o.tokens), 0);
    const sold = sells.reduce((n, o) => n + Number(o.tokens), 0);
    return {
      ok: true,
      held: Math.max(0, bought - sold),
      deliveries: buys.map((o) => ({ orderId: o.id, txid: o.txid as string, tokens: Number(o.tokens) })),
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
      // Unconfirmed-safe ancestry BEEF: a fresh mint (and every subsequent delivery,
      // which moves the vault to a NEW unconfirmed tx) has no `/beef` yet, so the plain
      // confirmed-only fetch would abort delivery. getSourceBeefDeep walks the ancestry
      // and anchors at confirmed roots, so back-to-back deliveries work immediately.
      const beef = await getSourceBeefDeep(vault.txid);
      if (!beef) throw new Error('could not build vault ancestry BEEF (could not anchor to a confirmed root — retry shortly)');

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
// STEP 2b · BUY RECOVERY (ADR-028). A buy whose TX-A (reserve buy) landed — the pool
// advanced and the `curve_buy` Order exists `pending` — but whose TX-B (operator STAS
// delivery) failed mid-flow leaves the buyer PAID with no tokens and `order.txid` null.
// The historical cause was `getSourceBeef` requiring a CONFIRMED vault (fixed above with
// getSourceBeefDeep); this control makes such a stuck buy RECOVERABLE regardless. Mirrors
// the sell recovery (STEP 3b): list the stuck buys, then DELEGATE to the existing
// idempotent `deliverStasToBuyer` (which claims pending→settling and is `order.txid`-
// idempotent). Buyer-scoped — a buyer can only complete their own delivery.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List a buyer's stuck buys: `curve_buy` orders in `pending`/`settling` with the reserve
 * buy recorded (`paymentTxid` set) but NO STAS delivered yet (`txid` null). These are the
 * orders `completePendingStasDelivery` can finish. Buyer-scoped. Minimal display info only.
 */
export async function getPendingStasDeliveries(saleId: string, buyerIdentity: string): Promise<
  { ok: true; orders: { orderId: string; tokens: number; paymentTxid: string | null }[] } | { ok: false; error: string }
> {
  try {
    if (!buyerIdentity) return { ok: false, error: 'buyerIdentity required' };
    const rows = await prisma.order.findMany({
      where: {
        saleId,
        buyerIdentity,
        kind: 'curve_buy',
        state: { in: ['pending', 'settling'] },
        txid: null, // no delivery yet
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      ok: true,
      orders: rows.map((o) => ({ orderId: o.id, tokens: Number(o.tokens), paymentTxid: o.paymentTxid })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Re-trigger the operator STAS delivery for a buyer's stuck buy order. Guards buyer
 * ownership + that the order is a pending/settling `curve_buy` not yet delivered, then
 * DELEGATES to the existing idempotent `deliverStasToBuyer` — no delivery logic is
 * duplicated here (it re-claims pending→settling, resolves the current vault, builds the
 * unconfirmed-safe BEEF, delivers + broadcasts, and is `order.txid`-idempotent). Buyer-scoped.
 */
export async function completePendingStasDelivery(input: { orderId: string; buyerIdentity: string }): Promise<{ ok: boolean; txid?: string; error?: string }> {
  try {
    if (!input.buyerIdentity) return { ok: false, error: 'buyerIdentity required' };
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order || order.kind !== 'curve_buy') return { ok: false, error: 'order not found or not a curve buy' };
    if (order.buyerIdentity !== input.buyerIdentity) return { ok: false, error: 'not your order' };
    if (order.txid) return { ok: true, txid: order.txid }; // already delivered (idempotent)
    if (!(order.state === 'pending' || order.state === 'settling')) return { ok: false, error: `order not completable (state ${order.state})` };
    // Delegate to the existing idempotent delivery (claims pending→settling, resolves the
    // current vault, builds the unconfirmed-safe ancestry BEEF, delivers + broadcasts).
    return await deliverStasToBuyer({ orderId: order.id });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 · SELL (ADR-028). A stas sell is TWO sequenced txs (see stasSellAssembly.ts
// for WHY it is not atomic — the covenant's ANYONECANPAY_ALL sell pins EXACTLY two
// outputs [successor pool, seller refund], no room for the STAS return):
//   TX1 "STAS return"  (holder-signed, client/wallet — DEFERRED UI): the holder
//        transfers `delta` STAS to the operator vault pkh.
//   TX2 "reserve refund" (operator-built + operator-cosigned): the operator funds the fee
//        input, co-signs the covenant input, and pays output 1 = the seller's recorded
//        address at the curve refund, then broadcasts.
// TRUST MODEL (honest): the covenant CAPS the refund at the curve price + pins the
// successor, and — with FIX 1/FIX 2 below — the sell is DRAIN-PROOF against malicious
// USERS (no oversell, no counterfeit, no double-refund). It does NOT cryptographically
// bind the payee: the operator supplies output 1, and a COMPROMISED operator key can
// redirect it — but a compromised operator key can already drain the whole reserve via
// forged sell-branch spends, so this is the already-accepted "operator key is reserve-
// critical" trust, not a new exposure. Two fixes harden against malicious users:
//   FIX 1 (replay) — the returned STAS OUTPOINT is UNIQUE evidence: `sellReturnOutpoint`
//     (@unique) blocks a second curve_sell order on the same return AT RECORD TIME, and
//     finalize re-checks the return is still UNSPENT on-chain before refunding.
//   FIX 2 (provenance) — back-to-genesis is a FULL-provenance walk (every same-tail input
//     must reach genuine issuance; amount-conserved; bounded; fail-closed), so a
//     [1 genuine + fabricated counterfeit] merge is rejected. In settle-actions.ts.
// Residual: liveness still rests on the operator broadcasting the refund.
// See DECISIONS.md ADR-028 step-3.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sequence a stas sell against the LATEST StasCurvePool outpoint and return the current
 * pool state + the operator VAULT pkh (where the holder returns `delta` STAS in TX1) +
 * the curve refund preview. Mirrors prepareStasBuy: this is the sequencing anchor — the
 * refund is FINALISED against the pool's actual `sold` at cosign time, so the preview may
 * shift if other trades land first.
 */
export async function prepareStasSell(input: { saleId: string; sellerIdentity: string; delta: number; sellerRefundAddress: string }): Promise<
  | { ok: true; pool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number; k: number; supply: number }; vaultPkh: string; vaultAddress: string; refund: number; delta: number }
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
    const { pkh: vaultPkh, address: vaultAddress } = await getOperator();
    return {
      ok: true,
      pool: { txid: p.poolTxid, vout: p.poolVout, scriptHex: p.scriptHex, reserveSats: Number(p.reserveSats), sold, k: Number(p.k), supply: Number(p.supply) },
      vaultPkh,
      vaultAddress,
      refund,
      delta: input.delta,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record a broadcast STAS return (TX1): create the `curve_sell` Order (state `pending`).
 * FIX 1 (replay): the returned STAS OUTPOINT is the unique sell evidence. We resolve the
 * exact vault-return output on-chain (`delta` tokens locked to the operator vault) and
 * store `sellReturnOutpoint = ${returnTxid}:${vout}` under a UNIQUE index — so a single
 * on-chain return can spawn AT MOST ONE refundable order (a duplicate hits P2002). The
 * pool is NOT advanced here — it moves in TX2 (finalizeStasSell).
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
    try {
      await p2pkhScriptHexForAddress(input.sellerRefundAddress);
    } catch {
      return { ok: false, error: 'invalid seller refund address' };
    }

    // Resolve the exact returned STAS outpoint (delta tokens to the operator vault). This
    // both validates the return exists on-chain and gives us the UNIQUE replay key.
    const { pkh: operatorPkh } = await getOperator();
    const returned = await findStasOutputToPkh(input.returnTxid, operatorPkh, input.delta);
    if (!returned) return { ok: false, error: `no STAS return of ${input.delta} to the vault found in ${input.returnTxid.slice(0, 12)}… (still propagating?)` };
    const sellReturnOutpoint = `${input.returnTxid}:${returned.vout}`;

    const refundPreview = Number(curveCost(pool.k, BigInt(Number(pool.sold) - input.delta), BigInt(input.delta)));
    let order;
    try {
      order = await prisma.order.create({
        data: {
          saleId: input.saleId,
          buyerIdentity: input.sellerIdentity,
          receiveAddress: input.sellerRefundAddress, // covenant refund payee (output 1)
          kind: 'curve_sell',
          tokens: BigInt(Math.floor(input.delta)),
          satsPaid: BigInt(Math.floor(refundPreview)), // finalised at cosign against actual `sold`
          state: 'pending', // awaiting operator refund (TX2)
          paymentTxid: input.returnTxid, // the holder's STAS return
          returnVout: returned.vout,
          sellReturnOutpoint, // UNIQUE — the anti-replay guard
        },
      });
    } catch (e) {
      // Unique-constraint violation → this returned outpoint already backs a sell order.
      if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
        return { ok: false, error: 'this STAS return already backs a sell order — one return, one refund' };
      }
      throw e;
    }
    await prisma.event.create({ data: { entity: 'Order', entityId: order.id, type: 'stas_sell_returned', payloadHash: input.returnTxid } });
    return { ok: true, orderId: order.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * TX2 · operator reserve-refund (backend). The operator funds the fee input, co-signs the
 * covenant input, and pays output 1 = the seller's recorded `receiveAddress` at the curve
 * refund, then broadcasts. Called explicitly after recordStasSell — never at import/build
 * time. Cosign + broadcast fire ONLY here.
 *
 * INVARIANTS: (FIX 1) the returned STAS outpoint is unique (record-time @unique) AND still
 * UNSPENT on-chain here — no double-refund. (FIX 2) FULL-provenance back-to-genesis MUST
 * pass — no refund for counterfeit/partly-fabricated STAS. The covenant CAPS the refund +
 * pins the successor (@bsv/sdk re-check inside buildStasSellRefundTx), so a malicious USER
 * cannot oversell/overpay; the pool advances only under the optimistic outpoint guard
 * (mirrors recordCurveBuy); sold never underflows. The payee is NOT covenant-bound — the
 * operator pays the seller's recorded address (a compromised operator key is already
 * reserve-critical; see the trust note above and DECISIONS.md ADR-028 step-3).
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

      // Resolve the returned STAS outpoint (delta tokens locked to the vault).
      const returnVout = order.returnVout ?? (await findStasOutputToPkh(order.paymentTxid, operatorPkh, delta))?.vout ?? null;
      if (returnVout == null) throw new Error(`no STAS return of ${delta} to the vault found in ${order.paymentTxid.slice(0, 12)}… — refusing refund`);

      // FIX 1 — the returned STAS must still be UNSPENT (not already re-delivered/swept).
      const unspent = await isOutputUnspent(order.paymentTxid, returnVout);
      if (unspent.unspent !== true) throw new Error(`returned STAS ${order.paymentTxid.slice(0, 12)}…:${returnVout} is not confirmably unspent (${unspent.unspent === false ? `spent by ${unspent.spentBy?.slice(0, 12)}…` : 'unverifiable'}) — refusing refund`);

      // FIX 2 — FULL-provenance back-to-genesis MUST pass before co-signing.
      const auth = await verifyStasBackToGenesis({ outpointTxid: order.paymentTxid, outpointVout: returnVout, issuanceTxid });
      if (!auth.authentic) throw new Error(`returned STAS failed back-to-genesis (${auth.reason}) — refusing refund`);

      // Build TX2 (operator-funded fee, operator cosign) against the LATEST pool outpoint;
      // output 1 = the seller's recorded address at the curve refund the covenant enforces.
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

      // Broadcast the fee-funding tx first, then TX2, retrying on "Missing inputs" while the
      // funding propagates (mirrors deliverStasToBuyer).
      if (res.fundingRawTx) await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
      let bc = await broadcastRawTx(res.rawTx, res.txid);
      for (let i = 0; i < 4 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        bc = await broadcastRawTx(res.rawTx, res.txid);
      }
      if (!bc.ok) throw new Error(`refund broadcast rejected: ${bc.error}`);
      const refundTxid = bc.txid || res.txid;

      // Advance the pool ONLY if it still sits at the outpoint TX2 spent (optimistic guard,
      // mirrors recordCurveBuy). sold -= delta (never underflows — guarded above).
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

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3b · RECOVERY (ADR-028). A sell whose TX1 (STAS return) landed but whose TX2
// (operator refund) failed mid-flow leaves a `curve_sell` Order stuck `pending`/`settling`
// with `paymentTxid`+`sellReturnOutpoint` set (STAS already back in the vault) but NO
// `refundTxid`. Re-clicking Sell would try to return STAS the seller no longer holds, so
// there is a dedicated retry: list the stuck orders, then delegate to the EXISTING
// idempotent `finalizeStasSell` (which claims pending→settling, re-verifies unspent + B2G,
// and refuses to double-refund). Seller-scoped — a seller can only complete their own order.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List a seller's stuck sell orders: `curve_sell` orders in `pending`/`settling` with the
 * STAS already returned (`sellReturnOutpoint`+`paymentTxid` set) but NOT yet refunded
 * (`refundTxid` null). These are the orders `completePendingStasSell` can finish. Returns
 * minimal display info only.
 */
export async function getPendingStasSells(saleId: string, sellerIdentity: string): Promise<
  { ok: true; orders: { orderId: string; tokens: number; paymentTxid: string }[] } | { ok: false; error: string }
> {
  try {
    if (!sellerIdentity) return { ok: false, error: 'sellerIdentity required' };
    const rows = await prisma.order.findMany({
      where: {
        saleId,
        buyerIdentity: sellerIdentity, // seller-scoped (buyerIdentity === sellerIdentity for curve_sell)
        kind: 'curve_sell',
        state: { in: ['pending', 'settling'] },
        refundTxid: null,
        sellReturnOutpoint: { not: null },
        paymentTxid: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      ok: true,
      orders: rows.map((o) => ({ orderId: o.id, tokens: Number(o.tokens), paymentTxid: o.paymentTxid as string })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Re-trigger the operator refund for a seller's stuck sell order. Guards seller ownership
 * (buyerIdentity === sellerIdentity) + that the order is a pending/settling `curve_sell`
 * with the STAS returned and no refund yet, then DELEGATES to the existing idempotent
 * `finalizeStasSell` — no finalize logic is duplicated here. Owner/seller-scoped.
 */
export async function completePendingStasSell(input: { orderId: string; sellerIdentity: string }): Promise<{ ok: boolean; txid?: string; error?: string }> {
  try {
    if (!input.sellerIdentity) return { ok: false, error: 'sellerIdentity required' };
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order || order.kind !== 'curve_sell') return { ok: false, error: 'order not found or not a curve sell' };
    if (order.buyerIdentity !== input.sellerIdentity) return { ok: false, error: 'not your order' };
    if (order.refundTxid) return { ok: true, txid: order.refundTxid }; // already refunded (idempotent)
    if (!(order.state === 'pending' || order.state === 'settling')) return { ok: false, error: `order not completable (state ${order.state})` };
    if (!order.sellReturnOutpoint || !order.paymentTxid) return { ok: false, error: 'order has no returned STAS to refund against' };
    // Delegate to the existing idempotent refund (claims pending→settling, re-verifies
    // unspent + full-provenance B2G, advances the pool, stamps refundTxid).
    return await finalizeStasSell({ orderId: order.id });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
