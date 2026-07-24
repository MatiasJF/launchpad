'use server';

import { prisma } from '@launchpad/db';
import { planMint, type MintPlan, type TokenSchema } from '@launchpad/bsv/issue';
import { isAdmin } from './auth';

/**
 * Build the STAS mint plan server-side (runs bsv/stas-js). The client passes the
 * wallet-derived owner + redemption public keys; nothing here touches a private
 * key. Returns a serializable plan the client shows before signing.
 */
export async function buildMintPlan(
  schema: TokenSchema,
  ownerPubkey: string,
  redemptionPubkey: string,
): Promise<MintPlan> {
  return planMint(schema, ownerPubkey, redemptionPubkey);
}

/** Record a completed issuance (the client already broadcast it via the wallet). */
export async function recordIssuance(projectId: string, txid: string, tokenId: string): Promise<void> {
  if (!(await isAdmin())) return;
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return;

  const token = await prisma.token.findFirst({ where: { projectId } });
  if (!token) return;

  await prisma.token.update({
    where: { id: token.id },
    data: { issuanceTxid: txid, stasTokenId: tokenId },
  });
  await prisma.event.create({
    data: { entity: 'Token', entityId: token.id, type: 'issued', payloadHash: txid },
  });
}
