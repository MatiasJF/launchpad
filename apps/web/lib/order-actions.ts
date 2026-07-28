'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { isAdmin } from './auth';

/**
 * A buyer places an order against a project's sale (state = pending).
 *
 * CONCURRENCY (buy layer — pure DB, no on-chain contention): the whole thing
 * runs in a transaction with an atomic oversell guard. If many buyers order at
 * once, each transaction re-reads the tokens already reserved (pending/settling/
 * settled) and refuses to cross `allocationForSale`. SQLite serializes writers,
 * so two concurrent buys can't both slip past the cap. (Postgres upgrade path:
 * a `sold` counter with `UPDATE … WHERE sold+n<=cap`, or SERIALIZABLE isolation
 * — see ADR-022.)
 *
 * NOTE: today BuyCard pays sats BEFORE calling this, so a rejected (oversold)
 * order means the buyer already paid and must be refunded. The correct fix is
 * reserve-then-pay (see ADR-022); tracked as a follow-up.
 */
export async function placeOrder(input: {
  projectId: string;
  buyerIdentity: string;
  receiveAddress: string;
  tokens: number;
  satsPaid: number;
  paymentTxid?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.receiveAddress || input.tokens <= 0) return { ok: false, error: 'invalid order' };
  const want = BigInt(Math.floor(input.tokens));

  try {
    await prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        include: { tokens: { include: { sales: true } } },
      });
      const sale = project?.tokens.flatMap((t) => t.sales)[0];
      if (!sale) throw new Error('no sale found for this project');

      // Atomic oversell guard: sum what's already reserved and reject anything
      // that would exceed the allocation. Inside the transaction so concurrent
      // buys can't both read the same "remaining" and both commit.
      const agg = await tx.order.aggregate({
        where: { saleId: sale.id, state: { in: ['pending', 'settling', 'settled'] } },
        _sum: { tokens: true },
      });
      const reserved = agg._sum.tokens ?? 0n;
      const remaining = sale.allocationForSale - reserved;
      if (want > remaining) {
        throw new Error(`only ${remaining} tokens left in this sale (you asked for ${want})`);
      }

      await tx.order.create({
        data: {
          saleId: sale.id,
          buyerIdentity: input.buyerIdentity,
          receiveAddress: input.receiveAddress,
          kind: 'instant_buy',
          tokens: want,
          satsPaid: BigInt(Math.floor(input.satsPaid)),
          state: 'pending',
          paymentTxid: input.paymentTxid ?? null,
        },
      });
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'order failed' };
  }
  revalidatePath('/admin');
  return { ok: true };
}

/**
 * Atomically claim a pending order for settlement (pending → settling).
 *
 * CONCURRENCY (settle layer): settlement spends the single pool STAS UTXO, which
 * is inherently serial — only one tx can spend a given UTXO. This claim is the
 * order-level lock that stops two admin tabs / a double-click from both building
 * a transfer for the SAME order (which would burn a funding tx and then fail with
 * "Missing inputs"). The flip is a single conditional UPDATE, so exactly one
 * caller wins. Release with `releaseOrderClaim` on failure; `markOrderSettled`
 * finalizes on success. (Pool-level serialization across DIFFERENT orders is the
 * operator-sequenced settlement queue — ADR-022.)
 */
export async function claimOrderForSettlement(orderId: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAdmin())) return { ok: false, error: 'unauthorized' };
  const res = await prisma.order.updateMany({
    where: { id: orderId, state: 'pending' },
    data: { state: 'settling' },
  });
  if (res.count === 0) return { ok: false, error: 'order is not pending (already settling or settled)' };
  // NB: deliberately NO revalidatePath here. This runs from inside the live
  // SettleOrderButton; revalidating '/admin' re-renders the pending list, drops
  // the now-'settling' order, and UNMOUNTS the component mid-settle (the flow
  // then aborts silently). Only the terminal markOrderSettled revalidates.
  return { ok: true };
}

/** Release a settlement claim back to pending (settling → pending) after a failed attempt. */
export async function releaseOrderClaim(orderId: string): Promise<void> {
  if (!(await isAdmin())) return;
  // No revalidatePath — same unmount reason as claimOrderForSettlement.
  await prisma.order.updateMany({ where: { id: orderId, state: 'settling' }, data: { state: 'pending' } });
}

/**
 * A buyer's settled orders that are ready to register into their wallet — i.e.
 * the operator delivered the tokens on-chain (state=settled, has a settlement
 * txid). Keyed by the buyer's BRC-100 identity. Returns everything the client
 * needs to internalize TX2:0 as a STAS basket insertion (txid + slug for the
 * derivation keyID). Idempotency lives wallet-side (basket-based), so re-listing
 * an already-registered order is harmless.
 */
export async function getBuyerClaimableOrders(buyerIdentity: string): Promise<
  { orderId: string; txid: string; tokens: string; slug: string; ticker: string; projectName: string }[]
> {
  if (!buyerIdentity) return [];
  const orders = await prisma.order.findMany({
    where: { buyerIdentity, state: 'settled', txid: { not: null } },
    include: { sale: { include: { token: { include: { project: true } } } } },
    orderBy: { updatedAt: 'desc' },
  });
  return orders.map((o) => ({
    orderId: o.id,
    txid: o.txid as string,
    tokens: o.tokens.toString(),
    slug: o.sale.token.project.slug,
    ticker: o.sale.token.ticker,
    projectName: o.sale.token.project.name,
  }));
}

/** Mark an order settled after the operator delivered the tokens on-chain. */
export async function markOrderSettled(orderId: string, transferTxid: string): Promise<void> {
  if (!(await isAdmin())) return;
  if (!/^[0-9a-fA-F]{64}$/.test(transferTxid)) return;
  // Only finalize an order that's actually in flight (settling) or pending — never
  // resurrect a refunded/failed one.
  const res = await prisma.order.updateMany({
    where: { id: orderId, state: { in: ['settling', 'pending'] } },
    data: { state: 'settled', txid: transferTxid },
  });
  if (res.count === 0) return;
  await prisma.event.create({
    data: { entity: 'Order', entityId: orderId, type: 'settled', payloadHash: transferTxid },
  });
  revalidatePath('/admin');
}
