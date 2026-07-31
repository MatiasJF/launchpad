'use server';

import { prisma } from '@launchpad/db';
import { Utils } from '@bsv/sdk';
import { isProjectOwner } from './account-actions';
import { buildLedgerBuy, ledgerSellDigest, ledgerSellUnlock, ledgerGenesisScript, ledgerGraduate, type LedgerOp } from './ledger-service';

/** hash160 (hex) of a P2PKH address — the covenant's payout key. */
function addrToPkh(addr: string): string {
  const { data } = Utils.fromBase58Check(addr);
  return Buffer.from(data as number[]).toString('hex');
}

/**
 * Trustless bonding-curve pool with in-covenant ledger (ADR-027). Buys credit and
 * sells debit a HashedMap keyed by the holder's pubkey — no forgeable token, reserve
 * drain-proof, no platform key. The scrypt-ts state math runs in a child process
 * (ledger-service) and must REPLAY the ordered op history to reconstruct the exact
 * on-chain instance (HashedMap is history-dependent), so the recorded Orders ARE the
 * source of truth for the pool's state.
 */

const LEDGER_K = 1n;
const LEDGER_SUPPLY = 1000n;

function curveCost(k: bigint, sold: bigint, delta: bigint): bigint {
  return (k * delta * (2n * sold + delta + 1n)) / 2n;
}

/** The ordered op history for a pool, oldest-first (buys +tokens, sells -tokens). */
async function poolHistory(saleId: string): Promise<LedgerOp[]> {
  const orders = await prisma.order.findMany({
    where: { saleId, kind: { in: ['curve_buy', 'curve_sell'] } },
    orderBy: { createdAt: 'asc' },
  });
  return orders.map((o) => ({
    ownerPkh: o.receiveAddress ?? '',
    delta: (o.kind === 'curve_sell' ? -o.tokens : o.tokens).toString(),
  }));
}

function balanceOf(history: LedgerOp[], ownerPkh: string): bigint {
  const id = ownerPkh.toLowerCase();
  return history.reduce((s, op) => (op.ownerPkh.toLowerCase() === id ? s + BigInt(op.delta) : s), 0n);
}

/** Owner-gated: create the ledger pool row + return the genesis script to deploy. */
export async function createLedgerPool(input: { saleId: string; identityPubkey: string; seedReserveSats: number }): Promise<{ ok: boolean; scriptHex?: string; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (input.seedReserveSats < 1) return { ok: false, error: 'seed reserve must be positive' };
    if (!sale.token.project.payoutAddress) return { ok: false, error: 'set a project payout address first (the reserve graduates there)' };
    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing && existing.status === 'live') return { ok: false, error: 'pool already live' };

    const payoutPkh = addrToPkh(sale.token.project.payoutAddress);
    const { scriptHex } = await ledgerGenesisScript({ k: LEDGER_K.toString(), supply: LEDGER_SUPPLY.toString(), payoutPkh });
    await prisma.curvePool.upsert({
      where: { saleId: input.saleId },
      create: { saleId: input.saleId, variant: 'ledger', k: LEDGER_K, supply: LEDGER_SUPPLY, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), payoutPkh, status: 'draft' },
      update: { variant: 'ledger', seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), payoutPkh },
    });
    return { ok: true, scriptHex };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Current ledger pool state + op history (for building a buy/sell client-side). */
export async function getLedgerPool(saleId: string): Promise<
  | { ok: true; poolTxid: string; poolVout: number; scriptHex: string; reserveSats: number; sold: number; k: string; supply: string; payoutPkh: string; history: LedgerOp[]; balances: { ownerPkh: string; amount: number }[] }
  | { ok: false; error: string }
> {
  const p = await prisma.curvePool.findUnique({ where: { saleId } });
  if (!p || p.variant !== 'ledger') return { ok: false, error: 'no ledger pool for this sale' };
  if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex || !p.payoutPkh) return { ok: false, error: 'pool is not live' };
  const history = await poolHistory(saleId);
  const byOwner = new Map<string, bigint>();
  for (const op of history) byOwner.set(op.ownerPkh, (byOwner.get(op.ownerPkh) ?? 0n) + BigInt(op.delta));
  const balances = [...byOwner.entries()].filter(([, a]) => a > 0n).map(([ownerPkh, a]) => ({ ownerPkh, amount: Number(a) }));
  return { ok: true, poolTxid: p.poolTxid, poolVout: p.poolVout, scriptHex: p.scriptHex, reserveSats: Number(p.reserveSats), sold: Number(p.sold), k: p.k.toString(), supply: p.supply.toString(), payoutPkh: p.payoutPkh, history, balances };
}

/** BUY step: build the pool-input unlock crediting `buyerPkh` by `delta`. */
export async function prepareLedgerBuy(input: { saleId: string; buyerPkh: string; delta: number }): Promise<
  | { ok: true; unlockingHex: string; sourceLockHex: string; nextLockingHex: string; newReserve: number; cost: number; poolTxid: string; poolVout: number; reserveBefore: number; sold: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getLedgerPool(input.saleId);
    if (!p.ok) return { ok: false, error: p.error };
    if (!Number.isInteger(input.delta) || input.delta <= 0) return { ok: false, error: 'delta must be a positive integer' };
    if (p.sold + input.delta > Number(p.supply)) return { ok: false, error: 'exceeds curve supply' };

    const cost = Number(curveCost(BigInt(p.k), BigInt(p.sold), BigInt(input.delta)));
    const newReserve = p.reserveSats + cost;
    const r = await buildLedgerBuy({ k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history, ownerPkh: input.buyerPkh, delta: input.delta.toString(), poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, newReserve });
    return { ok: true, ...r, newReserve, cost, poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, sold: p.sold };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Advance the pool + record the buy Order (which extends the op history). */
export async function recordLedgerBuy(input: {
  saleId: string; buyerIdentity: string; buyerPkh: string; spentPoolTxid: string; spentPoolVout: number;
  buyTxid: string; newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number }; delta: number; cost: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool) return { ok: false, error: 'no pool' };
      if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) return { ok: false, error: 'pool moved — rebuild against the latest outpoint' };
      await tx.curvePool.update({ where: { saleId: input.saleId }, data: { poolTxid: input.newPool.txid, poolVout: input.newPool.vout, scriptHex: input.newPool.scriptHex, reserveSats: BigInt(Math.floor(input.newPool.reserveSats)), sold: BigInt(Math.floor(input.newPool.sold)) } });
      await tx.order.create({ data: { saleId: input.saleId, buyerIdentity: input.buyerIdentity, receiveAddress: input.buyerPkh, kind: 'curve_buy', tokens: BigInt(Math.floor(input.delta)), satsPaid: BigInt(Math.floor(input.cost)), state: 'settled', paymentTxid: input.buyTxid, txid: input.buyTxid } });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** SELL step 1: the digest the holder signs + successor/payout/refund. */
export async function prepareLedgerSell(input: { saleId: string; sellerPkh: string; amount: number; payoutScriptHex: string }): Promise<
  | { ok: true; digestHex: string; sourceLockHex: string; nextLockingHex: string; payoutScriptHex: string; refund: number; reserveAfter: number; poolTxid: string; poolVout: number; reserveBefore: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getLedgerPool(input.saleId);
    if (!p.ok) return { ok: false, error: p.error };
    if (balanceOf(p.history, input.sellerPkh) < BigInt(input.amount)) return { ok: false, error: 'insufficient ledger balance' };
    const r = await ledgerSellDigest({ k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history, ownerPkh: input.sellerPkh, amount: input.amount.toString(), poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, payoutScriptHex: input.payoutScriptHex });
    return { ok: true, ...r, refund: Number(r.refund), poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** SELL step 2: build the pool-input unlock from the holder's signature. */
export async function finalizeLedgerSell(input: { saleId: string; sellerPkh: string; ownerPubHex: string; amount: number; payoutScriptHex: string; sigDerHex: string }): Promise<
  | { ok: true; unlockingHex: string; sourceLockHex: string; nextLockingHex: string; refund: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getLedgerPool(input.saleId);
    if (!p.ok) return { ok: false, error: p.error };
    const r = await ledgerSellUnlock({ k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history, ownerPkh: input.sellerPkh, ownerPubHex: input.ownerPubHex, amount: input.amount.toString(), poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, payoutScriptHex: input.payoutScriptHex, sigDerHex: input.sigDerHex });
    return { ok: true, ...r, refund: Number(r.refund) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Advance the pool + record the sell Order (which extends the op history). */
export async function recordLedgerSell(input: {
  saleId: string; sellerIdentity: string; sellerPkh: string; spentPoolTxid: string; spentPoolVout: number;
  sellTxid: string; newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number }; amount: number; refund: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool) return { ok: false, error: 'no pool' };
      if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) return { ok: false, error: 'pool moved — rebuild against the latest outpoint' };
      await tx.curvePool.update({ where: { saleId: input.saleId }, data: { poolTxid: input.newPool.txid, poolVout: input.newPool.vout, scriptHex: input.newPool.scriptHex, reserveSats: BigInt(Math.floor(input.newPool.reserveSats)), sold: BigInt(Math.floor(input.newPool.sold)) } });
      await tx.order.create({ data: { saleId: input.saleId, buyerIdentity: input.sellerIdentity, receiveAddress: input.sellerPkh, kind: 'curve_sell', tokens: BigInt(Math.floor(input.amount)), satsPaid: BigInt(Math.floor(input.refund)), state: 'settled', paymentTxid: input.sellTxid, txid: input.sellTxid } });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GRADUATION step: build the terminal spend releasing the reserve to the payout. */
export async function prepareLedgerGraduate(input: { saleId: string }): Promise<
  | { ok: true; unlockingHex: string; sourceLockHex: string; payoutScriptHex: string; reserve: number; poolTxid: string; poolVout: number; reserveBefore: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getLedgerPool(input.saleId);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.sold < Number(p.supply)) return { ok: false, error: `curve not fully sold (${p.sold}/${p.supply})` };
    const r = await ledgerGraduate({ k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history, poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats });
    return { ok: true, ...r, poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mark the pool graduated after the reserve-release tx broadcasts. */
export async function recordLedgerGraduate(input: { saleId: string; spentPoolTxid: string; spentPoolVout: number; graduateTxid: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool) return { ok: false, error: 'no pool' };
      if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) return { ok: false, error: 'pool moved — rebuild against the latest outpoint' };
      await tx.curvePool.update({ where: { saleId: input.saleId }, data: { status: 'graduated', poolTxid: input.graduateTxid, poolVout: 0 } });
      await tx.sale.update({ where: { id: input.saleId }, data: { status: 'finalized' } });
      await tx.event.create({ data: { entity: 'CurvePool', entityId: input.saleId, type: 'graduated', payloadHash: input.graduateTxid } });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
