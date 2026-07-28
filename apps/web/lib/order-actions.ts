'use server';

import { prisma } from '@launchpad/db';
import type { Prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { isAdmin } from './auth';
import { verifyPaymentToAddress } from './settle-actions';

/**
 * How long a reservation holds its slice of the allocation before it lazily
 * expires. The buyer reserves → pays → confirms inside this window; abandoned
 * reservations (buyer never paid) stop counting against the cap after it, so
 * the tokens free up automatically with no sweep job needed.
 */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * Atomic oversell check used by both reserve and payment-confirm. Sums tokens
 * that currently hold allocation — settled/settling/pending, plus *fresh*
 * reservations (within TTL) — optionally excluding one order (so confirm can
 * re-check without counting itself). Runs inside the caller's transaction.
 */
async function remainingForSale(
  tx: Prisma.TransactionClient,
  saleId: string,
  allocationForSale: bigint,
  excludeOrderId?: string,
): Promise<bigint> {
  const ttlCutoff = new Date(Date.now() - RESERVATION_TTL_MS);
  const agg = await tx.order.aggregate({
    where: {
      saleId,
      id: excludeOrderId ? { not: excludeOrderId } : undefined,
      OR: [
        { state: { in: ['pending', 'settling', 'settled'] } },
        { state: 'reserved', createdAt: { gt: ttlCutoff } },
      ],
    },
    _sum: { tokens: true },
  });
  return allocationForSale - (agg._sum.tokens ?? 0n);
}

/**
 * Reserve a slice of the sale allocation BEFORE the buyer pays (reserve-then-pay,
 * ADR-022). Atomic oversell guard inside a transaction — concurrent buyers can't
 * both reserve the same last tokens. Creates the order in `reserved` (unpaid);
 * the buyer then pays and calls `confirmOrderPayment`. If they abandon it, the
 * reservation lazily expires (TTL) and the tokens free up.
 */
export async function reserveOrder(input: {
  projectId: string;
  buyerIdentity: string;
  receiveAddress: string;
  tokens: number;
}): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  if (!input.receiveAddress || input.tokens <= 0) return { ok: false, error: 'invalid order' };
  const want = BigInt(Math.floor(input.tokens));

  try {
    const orderId = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        include: { tokens: { include: { sales: true } } },
      });
      const sale = project?.tokens.flatMap((t) => t.sales)[0];
      if (!sale) throw new Error('no sale found for this project');

      // Sale must be OPEN: live and within its start/end window. This is the real
      // gate (the UI hides the button, but the action must enforce it too).
      const now = new Date();
      if (sale.status !== 'live') throw new Error('this sale is not open for buying');
      if (sale.startsAt && sale.startsAt > now) throw new Error('this sale has not started yet');
      if (sale.endsAt && sale.endsAt <= now) throw new Error('this sale has ended');

      const remaining = await remainingForSale(tx, sale.id, sale.allocationForSale);
      if (want > remaining) throw new Error(`only ${remaining} tokens left in this sale (you asked for ${want})`);

      const order = await tx.order.create({
        data: {
          saleId: sale.id,
          buyerIdentity: input.buyerIdentity,
          receiveAddress: input.receiveAddress,
          kind: 'instant_buy',
          tokens: want,
          satsPaid: 0n,
          state: 'reserved',
        },
      });
      return order.id;
    });
    return { ok: true, orderId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'reservation failed' };
  }
}

/**
 * Confirm a reservation after the buyer paid (reserved → pending). Re-checks the
 * allocation (excluding this order) in case the reservation sat past its TTL and
 * the tokens were taken meanwhile — so a slow buyer can't oversell on confirm.
 * Once pending, the order is settle-eligible.
 */
export async function confirmOrderPayment(
  orderId: string,
  satsPaid: number,
  paymentTxid?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. Load the order + pricing/payout (read only) and run state checks.
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { sale: { include: { token: { include: { project: true } } } } },
    });
    if (!order) throw new Error('reservation not found');
    if (order.state === 'pending' || order.state === 'settling' || order.state === 'settled') {
      return { ok: true }; // already confirmed — idempotent
    }
    if (order.state !== 'reserved') throw new Error(`order is ${order.state}, not reservable`);

    // 2. Verify payment ON-CHAIN before confirming (network call OUTSIDE any tx so
    //    we don't hold a DB write lock while polling WoC). Cost is server-computed
    //    (tokens × price) — we never trust the client's number. Proceeds go 100%
    //    to the project's payout address.
    const cost = order.tokens * order.sale.priceSats; // BigInt sats
    if (cost > 0n) {
      const payout = order.sale.token.project.payoutAddress;
      if (!payout) throw new Error('this sale has no payout address configured');
      if (!paymentTxid) throw new Error('payment is required for this sale');
      const v = await verifyPaymentToAddress(paymentTxid, payout, Number(cost));
      if (!v.ok) throw new Error(v.error ?? 'payment could not be verified on-chain');
    }

    // 3. Short transaction: re-check the order is still reservable + allocation
    //    still available, then flip reserved → pending (settle-eligible).
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.order.findUnique({ where: { id: orderId }, include: { sale: true } });
      if (!fresh || fresh.state !== 'reserved') throw new Error('reservation is no longer pending confirmation');
      const remaining = await remainingForSale(tx, fresh.saleId, fresh.sale.allocationForSale, orderId);
      if (fresh.tokens > remaining) throw new Error('reservation expired and the tokens were taken — please try again');
      await tx.order.update({
        where: { id: orderId },
        data: { state: 'pending', satsPaid: BigInt(Math.floor(satsPaid)), paymentTxid: paymentTxid ?? null },
      });
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'payment confirmation failed' };
  }
  revalidatePath('/admin');
  return { ok: true };
}

/**
 * Back-compat one-shot place (reserve + confirm in one call). Retained for any
 * caller that pays first; new buy flow uses reserve-then-pay so an oversold order
 * is rejected BEFORE payment. Prefer reserveOrder + confirmOrderPayment.
 */
export async function placeOrder(input: {
  projectId: string;
  buyerIdentity: string;
  receiveAddress: string;
  tokens: number;
  satsPaid: number;
  paymentTxid?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const r = await reserveOrder(input);
  if (!r.ok || !r.orderId) return { ok: false, error: r.error };
  return confirmOrderPayment(r.orderId, input.satsPaid, input.paymentTxid);
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
  // Exclude orders the buyer already registered into their wallet, so a claimed
  // token stops re-appearing on every reload (the wallet-side receive is already
  // idempotent; this hides it from the list too).
  const registered = await prisma.event.findMany({
    where: { entity: 'Order', type: 'registered', entityId: { in: orders.map((o) => o.id) } },
    select: { entityId: true },
  });
  const regSet = new Set(registered.map((e) => e.entityId));
  return orders
    .filter((o) => !regSet.has(o.id))
    .map((o) => ({
    orderId: o.id,
    txid: o.txid as string,
    tokens: o.tokens.toString(),
    slug: o.sale.token.project.slug,
    ticker: o.sale.token.ticker,
    projectName: o.sale.token.project.name,
  }));
}

/**
 * Record that a buyer registered an order's tokens into their wallet, so it drops
 * off the claimable list. Idempotent — a repeat call is a no-op. Bookkeeping only;
 * the wallet-side receive is the real (idempotent) action.
 */
export async function markOrderRegistered(orderId: string): Promise<void> {
  if (!orderId) return;
  const existing = await prisma.event.findFirst({
    where: { entity: 'Order', entityId: orderId, type: 'registered' },
  });
  if (existing) return;
  await prisma.event.create({ data: { entity: 'Order', entityId: orderId, type: 'registered', payloadHash: orderId } });
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
