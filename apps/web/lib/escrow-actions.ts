'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { isProjectOwner } from './account-actions';
import { isOutputUnspent } from './settle-actions';

/**
 * Record a contributor's assurance-contract pledge (ADR-025). Non-custodial: we
 * store only the signed input (0xC1 signature + outpoint), never keys or funds.
 * The pledge's funding tx has already been broadcast by the client so the UTXO
 * exists on-chain; the signature lets the operator later assemble it into the
 * assurance tx if the soft cap is met.
 */
export async function recordPledge(input: {
  saleId: string;
  contributor: string;
  receiveAddress: string;
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  sigHex: string;
  pubkeyHex: string;
  derivationPrefix: string;
  derivationSuffix: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.contributor || !input.receiveAddress) return { ok: false, error: 'missing contributor/receive address' };
  if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) return { ok: false, error: 'invalid pledge txid' };
  try {
    // Sale must be a live escrow presale, and not already over its hard cap.
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId } });
    if (!sale || sale.type !== 'escrow_presale') return { ok: false, error: 'not an escrow presale' };
    if (sale.status !== 'live') return { ok: false, error: 'presale is not open' };

    const active = await prisma.pledge.aggregate({
      where: { saleId: input.saleId, state: { in: ['pledged', 'assembled'] } },
      _sum: { satoshis: true },
    });
    const raised = active._sum.satoshis ?? 0n;
    if (sale.hardCap != null && raised + BigInt(input.satoshis) > sale.hardCap) {
      return { ok: false, error: 'this pledge would exceed the hard cap' };
    }

    await prisma.pledge.create({
      data: {
        saleId: input.saleId,
        contributor: input.contributor,
        receiveAddress: input.receiveAddress,
        txid: input.txid,
        vout: input.vout,
        satoshis: BigInt(Math.floor(input.satoshis)),
        scriptHex: input.scriptHex,
        sigHex: input.sigHex,
        pubkeyHex: input.pubkeyHex,
        derivationPrefix: input.derivationPrefix,
        derivationSuffix: input.derivationSuffix,
        state: 'pledged',
      },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not record pledge' };
  }
  revalidatePath('/');
  return { ok: true };
}

/**
 * Owner-gated: gather the exact set of still-unspent pledges that composes to the
 * soft cap, ready for the client to assemble into the assurance tx. Re-validates
 * every candidate pledge is unspent on-chain (a contributor may have withdrawn by
 * spending their UTXO) and returns the fixed output (soft cap + project address).
 */
export async function getPledgesForAssembly(
  saleId: string,
  identityPubkey: string,
): Promise<
  | {
      ok: true;
      softCapSats: number;
      projectAddress: string;
      pledges: {
        id: string;
        txid: string;
        vout: number;
        satoshis: number;
        scriptHex: string;
        sigHex: string;
        pubkeyHex: string;
      }[];
    }
  | { ok: false; error: string }
> {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { token: { include: { project: true } } },
  });
  if (!sale || sale.type !== 'escrow_presale') return { ok: false, error: 'not an escrow presale' };
  if (!(await isProjectOwner(sale.token.projectId, identityPubkey))) return { ok: false, error: 'not the project owner' };
  const payout = sale.token.project.payoutAddress;
  if (!payout) return { ok: false, error: 'project has no payout address' };
  if (sale.softCap == null) return { ok: false, error: 'no soft cap set' };
  const softCap = Number(sale.softCap);

  const candidates = await prisma.pledge.findMany({
    where: { saleId, state: 'pledged' },
    orderBy: { createdAt: 'asc' },
  });

  // Re-validate unspent and select a subset summing to exactly the soft cap.
  const selected: {
    id: string;
    txid: string;
    vout: number;
    satoshis: number;
    scriptHex: string;
    sigHex: string;
    pubkeyHex: string;
  }[] = [];
  let sum = 0;
  for (const p of candidates) {
    if (sum >= softCap) break;
    const spentCheck = await isOutputUnspent(p.txid, p.vout);
    if (spentCheck.unspent !== true) continue; // withdrawn / stale — skip
    const sats = Number(p.satoshis);
    if (sum + sats > softCap) continue; // would overshoot the fixed output; skip
    selected.push({ id: p.id, txid: p.txid, vout: p.vout, satoshis: sats, scriptHex: p.scriptHex, sigHex: p.sigHex, pubkeyHex: p.pubkeyHex });
    sum += sats;
  }
  if (sum !== softCap) {
    return { ok: false, error: `not enough unspent pledges to reach the soft cap (have ${sum}, need ${softCap})` };
  }
  return { ok: true, softCapSats: softCap, projectAddress: payout, pledges: selected };
}

/** Owner-gated: after the assurance tx broadcasts, mark pledges assembled + finalize. */
export async function markAssemblyBroadcast(
  saleId: string,
  identityPubkey: string,
  assuranceTxid: string,
  pledgeIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { token: true } });
  if (!sale) return { ok: false, error: 'sale not found' };
  if (!(await isProjectOwner(sale.token.projectId, identityPubkey))) return { ok: false, error: 'not the project owner' };
  if (!/^[0-9a-fA-F]{64}$/.test(assuranceTxid)) return { ok: false, error: 'invalid assurance txid' };
  await prisma.pledge.updateMany({ where: { id: { in: pledgeIds } }, data: { state: 'assembled' } });
  await prisma.sale.update({ where: { id: saleId }, data: { status: 'finalized' } });
  await prisma.event.create({ data: { entity: 'Sale', entityId: saleId, type: 'assurance', payloadHash: assuranceTxid } });
  revalidatePath('/');
  return { ok: true };
}

/** A presale's aggregate state (raised vs soft/hard cap) for display + assembly. */
export async function getPresaleState(saleId: string): Promise<{
  raisedSats: string;
  pledgeCount: number;
} | null> {
  const agg = await prisma.pledge.aggregate({
    where: { saleId, state: { in: ['pledged', 'assembled'] } },
    _sum: { satoshis: true },
    _count: true,
  });
  return { raisedSats: (agg._sum.satoshis ?? 0n).toString(), pledgeCount: agg._count };
}
