'use server';

import { prisma } from '@launchpad/db';
import { planMint, type MintPlan, type TokenSchema } from '@launchpad/bsv/issue';

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

/**
 * Record a completed issuance. Called from the project owner's dashboard after
 * their wallet issued the genesis on-chain — NOT admin-gated (the owner, not the
 * platform, issues). The on-chain signature is the real authority: only the
 * owner's key could have produced a genesis for their derived token, so this is
 * bookkeeping over an already-committed fact.
 */
export async function recordIssuance(projectId: string, txid: string, tokenId: string): Promise<void> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return;

  const token = await prisma.token.findFirst({ where: { projectId } });
  if (!token) return;

  await prisma.token.update({
    where: { id: token.id },
    data: { issuanceTxid: txid, stasTokenId: tokenId },
  });
  // An issued token's sale opens for buyers.
  await prisma.sale.updateMany({ where: { tokenId: token.id }, data: { status: 'live' } });
  await prisma.event.create({
    data: { entity: 'Token', entityId: token.id, type: 'issued', payloadHash: txid },
  });
}
