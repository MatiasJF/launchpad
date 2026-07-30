'use server';

import { prisma } from '@launchpad/db';
import { isProjectOwner } from './account-actions';
import { buildLedgerBuy, ledgerSellDigest, ledgerSellUnlock, ledgerGenesisScript, type LedgerBalance } from './ledger-service';

/**
 * Trustless bonding-curve pool with in-covenant ledger (ADR-027). Buys credit and
 * sells debit a HashedMap balance keyed by the holder's pubkey — no forgeable token,
 * reserve drain-proof, no platform key. The scrypt-ts state math runs in a child
 * process (ledger-service); here we persist the mirror ledger + sequence spends.
 */

const LEDGER_K = 1n;
const LEDGER_SUPPLY = 1000n;

function parseBalances(json: string | null): LedgerBalance[] {
  if (!json) return [];
  try { return JSON.parse(json) as LedgerBalance[]; } catch { return []; }
}
function curveCost(k: bigint, sold: bigint, delta: bigint): bigint {
  return (k * delta * (2n * sold + delta + 1n)) / 2n;
}
function applyDelta(balances: LedgerBalance[], ownerPkh: string, delta: bigint): LedgerBalance[] {
  const out = balances.map((b) => ({ ...b }));
  const i = out.findIndex((b) => b.ownerPkh.toLowerCase() === ownerPkh.toLowerCase());
  if (i === -1) out.push({ ownerPkh, amount: delta.toString() });
  else out[i]!.amount = (BigInt(out[i]!.amount) + delta).toString();
  return out.filter((b) => BigInt(b.amount) > 0n);
}

/** Owner-gated: create the ledger pool row + return the genesis script to deploy. */
export async function createLedgerPool(input: { saleId: string; identityPubkey: string; seedReserveSats: number }): Promise<{ ok: boolean; scriptHex?: string; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (input.seedReserveSats < 1) return { ok: false, error: 'seed reserve must be positive' };

    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing && existing.status === 'live') return { ok: false, error: 'pool already live' };

    const { scriptHex } = await ledgerGenesisScript({ k: LEDGER_K.toString(), supply: LEDGER_SUPPLY.toString() });

    await prisma.curvePool.upsert({
      where: { saleId: input.saleId },
      create: { saleId: input.saleId, variant: 'ledger', k: LEDGER_K, supply: LEDGER_SUPPLY, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), ledgerBalances: '[]', status: 'draft' },
      update: { variant: 'ledger', ledgerBalances: '[]', seedReserveSats: BigInt(Math.floor(input.seedReserveSats)) },
    });
    return { ok: true, scriptHex };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read the current ledger pool state (for building a buy/sell client-side). */
export async function getLedgerPool(saleId: string): Promise<
  | { ok: true; poolTxid: string; poolVout: number; scriptHex: string; reserveSats: number; sold: number; k: string; supply: string; balances: LedgerBalance[] }
  | { ok: false; error: string }
> {
  const p = await prisma.curvePool.findUnique({ where: { saleId } });
  if (!p || p.variant !== 'ledger') return { ok: false, error: 'no ledger pool for this sale' };
  if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex) return { ok: false, error: 'pool is not live' };
  return {
    ok: true, poolTxid: p.poolTxid, poolVout: p.poolVout, scriptHex: p.scriptHex,
    reserveSats: Number(p.reserveSats), sold: Number(p.sold), k: p.k.toString(), supply: p.supply.toString(),
    balances: parseBalances(p.ledgerBalances),
  };
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
    const r = await buildLedgerBuy({
      sold: p.sold.toString(), k: p.k, supply: p.supply, balances: p.balances,
      ownerPkh: input.buyerPkh, delta: input.delta.toString(),
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, newReserve,
    });
    return { ok: true, ...r, newReserve, cost, poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, sold: p.sold };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Advance the pool + credit the ledger after a buy broadcasts (optimistic guard). */
export async function recordLedgerBuy(input: {
  saleId: string; buyerIdentity: string; buyerPkh: string; spentPoolTxid: string; spentPoolVout: number;
  buyTxid: string; newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number }; delta: number; cost: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool) return { ok: false, error: 'no pool' };
      if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) return { ok: false, error: 'pool moved — rebuild against the latest outpoint' };
      const balances = applyDelta(parseBalances(pool.ledgerBalances), input.buyerPkh, BigInt(input.delta));
      await tx.curvePool.update({
        where: { saleId: input.saleId },
        data: { poolTxid: input.newPool.txid, poolVout: input.newPool.vout, scriptHex: input.newPool.scriptHex, reserveSats: BigInt(Math.floor(input.newPool.reserveSats)), sold: BigInt(Math.floor(input.newPool.sold)), ledgerBalances: JSON.stringify(balances) },
      });
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
    const held = p.balances.find((b) => b.ownerPkh.toLowerCase() === input.sellerPkh.toLowerCase());
    if (!held || BigInt(held.amount) < BigInt(input.amount)) return { ok: false, error: 'insufficient ledger balance' };

    const r = await ledgerSellDigest({
      sold: p.sold.toString(), k: p.k, supply: p.supply, balances: p.balances,
      ownerPkh: input.sellerPkh, amount: input.amount.toString(),
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, payoutScriptHex: input.payoutScriptHex,
    });
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
    const r = await ledgerSellUnlock({
      sold: p.sold.toString(), k: p.k, supply: p.supply, balances: p.balances,
      ownerPkh: input.sellerPkh, ownerPubHex: input.ownerPubHex, amount: input.amount.toString(),
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, payoutScriptHex: input.payoutScriptHex, sigDerHex: input.sigDerHex,
    });
    return { ok: true, ...r, refund: Number(r.refund) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Advance the pool + debit the ledger after a sell broadcasts (optimistic guard). */
export async function recordLedgerSell(input: {
  saleId: string; sellerIdentity: string; sellerPkh: string; spentPoolTxid: string; spentPoolVout: number;
  sellTxid: string; newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number }; amount: number; refund: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool) return { ok: false, error: 'no pool' };
      if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) return { ok: false, error: 'pool moved — rebuild against the latest outpoint' };
      const balances = applyDelta(parseBalances(pool.ledgerBalances), input.sellerPkh, -BigInt(input.amount));
      await tx.curvePool.update({
        where: { saleId: input.saleId },
        data: { poolTxid: input.newPool.txid, poolVout: input.newPool.vout, scriptHex: input.newPool.scriptHex, reserveSats: BigInt(Math.floor(input.newPool.reserveSats)), sold: BigInt(Math.floor(input.newPool.sold)), ledgerBalances: JSON.stringify(balances) },
      });
      await tx.order.create({ data: { saleId: input.saleId, buyerIdentity: input.sellerIdentity, receiveAddress: input.sellerPkh, kind: 'curve_sell', tokens: BigInt(Math.floor(input.amount)), satsPaid: BigInt(Math.floor(input.refund)), state: 'settled', paymentTxid: input.sellTxid, txid: input.sellTxid } });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
