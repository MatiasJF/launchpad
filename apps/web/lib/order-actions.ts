'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { isAdmin } from './auth';

/** A buyer places an order against a project's sale (state = pending). */
export async function placeOrder(input: {
  projectId: string;
  buyerIdentity: string;
  receiveAddress: string;
  tokens: number;
  satsPaid: number;
  paymentTxid?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    include: { tokens: { include: { sales: true } } },
  });
  const sale = project?.tokens.flatMap((t) => t.sales)[0];
  if (!sale) return { ok: false, error: 'no sale found for this project' };
  if (!input.receiveAddress || input.tokens <= 0) return { ok: false, error: 'invalid order' };

  await prisma.order.create({
    data: {
      saleId: sale.id,
      buyerIdentity: input.buyerIdentity,
      receiveAddress: input.receiveAddress,
      kind: 'instant_buy',
      tokens: BigInt(Math.floor(input.tokens)),
      satsPaid: BigInt(Math.floor(input.satsPaid)),
      state: 'pending',
      paymentTxid: input.paymentTxid ?? null,
    },
  });
  revalidatePath('/admin');
  return { ok: true };
}

/** Mark an order settled after the operator delivered the tokens on-chain. */
export async function markOrderSettled(orderId: string, transferTxid: string): Promise<void> {
  if (!(await isAdmin())) return;
  if (!/^[0-9a-fA-F]{64}$/.test(transferTxid)) return;
  await prisma.order.update({ where: { id: orderId }, data: { state: 'settled', txid: transferTxid } });
  await prisma.event.create({
    data: { entity: 'Order', entityId: orderId, type: 'settled', payloadHash: transferTxid },
  });
  revalidatePath('/admin');
}
