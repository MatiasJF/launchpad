'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { isProjectOwner } from './account-actions';

/**
 * Bonding-curve server actions (ADR-026, Phase 1). The operator never holds keys
 * or funds — these actions only persist the pool covenant's on-chain state so buys
 * can be sequenced against the latest outpoint (BSV has no global mutable state).
 */

/** Owner-gated: create the CurvePool row for a sale (before it is deployed). */
export async function createCurvePool(input: {
  saleId: string;
  identityPubkey: string;
  seedReserveSats: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (input.seedReserveSats < 1) return { ok: false, error: 'seed reserve must be positive' };

    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing) return { ok: false, error: 'pool already exists for this sale' };

    // Phase 1 params are the compiled constants; the covenant script is fixed.
    const { CURVE_PARAMS } = await import('@launchpad/curve');
    await prisma.curvePool.create({
      data: {
        saleId: input.saleId,
        k: BigInt(CURVE_PARAMS.k),
        supply: BigInt(CURVE_PARAMS.supply),
        seedReserveSats: BigInt(Math.floor(input.seedReserveSats)),
        status: 'draft',
      },
    });
    revalidatePath(`/project/${sale.token.project.slug}/manage`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Owner-gated: record the deployed pool covenant UTXO (draft -> live). */
export async function markCurvePoolDeployed(input: {
  saleId: string;
  identityPubkey: string;
  txid: string;
  vout: number;
  scriptHex: string;
  reserveSats: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) return { ok: false, error: 'invalid deploy txid' };
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };

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
    // open the sale for buying
    await prisma.sale.update({ where: { id: input.saleId }, data: { status: 'live' } });
    await prisma.event.create({ data: { entity: 'CurvePool', entityId: input.saleId, type: 'pool_deployed' } });
    revalidatePath(`/sale/${sale.token.project.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Current pool state for building a buy (the client assembles the buy tx). */
export async function getCurvePoolState(saleId: string): Promise<
  | { ok: true; pool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number; k: number; supply: number } }
  | { ok: false; error: string }
> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId } });
    if (!p) return { ok: false, error: 'no pool for this sale' };
    if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex) return { ok: false, error: 'pool is not live yet' };
    return {
      ok: true,
      pool: {
        txid: p.poolTxid, vout: p.poolVout, scriptHex: p.scriptHex,
        reserveSats: Number(p.reserveSats), sold: Number(p.sold),
        k: Number(p.k), supply: Number(p.supply),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Advance the pool after a buy is broadcast. CONCURRENCY: the single pool UTXO can
 * only be spent once, so we advance ONLY if the pool still sits at the outpoint the
 * buy spent (optimistic guard). A racing buyer whose tx spent the same outpoint
 * would have failed at broadcast anyway; this stops a stale advance from corrupting
 * the tracked state. Records the buy as an Order(kind=curve_buy, settled).
 */
export async function recordCurveBuy(input: {
  saleId: string;
  buyerIdentity: string;
  receiveAddress: string;
  spentPoolTxid: string; // the pool outpoint this buy consumed
  spentPoolVout: number;
  buyTxid: string;
  newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number };
  delta: number;
  cost: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.buyTxid)) return { ok: false, error: 'invalid buy txid' };
  try {
    return await prisma.$transaction(async (tx) => {
      const pool = await tx.curvePool.findUnique({ where: { saleId: input.saleId } });
      if (!pool) return { ok: false, error: 'no pool for this sale' };
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
      await tx.order.create({
        data: {
          saleId: input.saleId,
          buyerIdentity: input.buyerIdentity,
          receiveAddress: input.receiveAddress,
          kind: 'curve_buy',
          tokens: BigInt(Math.floor(input.delta)),
          satsPaid: BigInt(Math.floor(input.cost)),
          state: 'settled',
          paymentTxid: input.buyTxid,
          txid: input.buyTxid,
        },
      });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
