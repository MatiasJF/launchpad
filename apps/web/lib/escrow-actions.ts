'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';

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
