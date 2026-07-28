'use server';

import { prisma } from '@launchpad/db';
import { isIdentityPubkey } from './identity';

/**
 * Upsert an Account by BRC-100 identity pubkey. Called when a wallet connects so
 * the person exists as an actor (project owner / buyer) in our records. Identity
 * IS the account key — non-custodial: we store the public key, never a secret.
 */
export async function upsertAccount(
  identityPubkey: string,
  paymail?: string,
): Promise<{ id: string; role: string } | null> {
  if (!isIdentityPubkey(identityPubkey)) return null;
  const acct = await prisma.account.upsert({
    where: { identityPubkey },
    update: paymail ? { paymail } : {},
    create: { identityPubkey, paymail: paymail ?? null, role: 'public' },
  });
  return { id: acct.id, role: acct.role };
}

/**
 * Is this identity the owner of the given project? This is the DB-level gate for
 * project-management actions. NOTE: the true authority is the on-chain wallet
 * signature — only the owner's key can issue or settle their token — so this
 * gate is defense-in-depth for the UI/records, not the thing that protects funds.
 */
export async function isProjectOwner(projectId: string, identityPubkey: string): Promise<boolean> {
  if (!isIdentityPubkey(identityPubkey)) return false;
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { owner: true } });
  return project?.owner.identityPubkey === identityPubkey;
}
