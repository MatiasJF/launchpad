'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { isProjectOwner } from './account-actions';
import { isOutputUnspent, getOutputInfo } from './settle-actions';


// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadBsv(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await import('bsv');
  return m.default ?? m;
}

/**
 * Prove a submitted pledge is real before it is allowed to occupy soft-cap space.
 *
 * `recordPledge` is reachable by anyone, and the only later gate was
 * `isOutputUnspent`, which cannot tell a NONEXISTENT output from an unspent one —
 * WhatsOnChain answers 404 for both. So `{ a real txid, vout: 99 }` used to be
 * accepted, counted toward the raise, blocking genuine contributors, and selected
 * for assembly, where its garbage unlocking script killed the broadcast. There is no
 * way to invalidate a Pledge row afterwards, so a handful of HTTP requests could
 * brick a presale permanently. Everything here is checked against the chain and the
 * contributor's own signature — nothing is taken on the client's word.
 */
async function validatePledgeOnChain(input: {
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  sigHex: string;
  pubkeyHex: string;
  softCapSats: number;
  projectAddress: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const info = await getOutputInfo(input.txid, input.vout);
  if (!info) return { ok: false, error: 'pledge outpoint does not exist on-chain' };
  if (info.satoshis !== input.satoshis) {
    return { ok: false, error: `pledge claims ${input.satoshis} sats, chain says ${info.satoshis}` };
  }
  if (info.scriptHex.toLowerCase() !== input.scriptHex.toLowerCase()) {
    return { ok: false, error: 'pledge locking script does not match the chain' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bsv: any;
  try {
    bsv = await loadBsv();
  } catch {
    return { ok: false, error: 'could not load the script engine to verify the pledge' };
  }

  try {
    // The output must actually be spendable by the pubkey the pledge signs with.
    const pkh = bsv.crypto.Hash.sha256ripemd160(Buffer.from(input.pubkeyHex, 'hex')).toString('hex');
    const expected = `76a914${pkh}88ac`;
    if (info.scriptHex.toLowerCase() !== expected) {
      return { ok: false, error: 'pledge output is not P2PKH to the pledging public key' };
    }

    // Rebuild the exact template the contributor signed — one input, one fixed
    // output — and check the 0xC1 signature against it. This is what makes the
    // pledge worth a soft-cap slot: it is now known to be assemblable.
    const recipientPkh = bsv.Address.fromString(input.projectAddress).hashBuffer.toString('hex');
    const tx = new bsv.Transaction();
    tx.from({ txId: input.txid, outputIndex: input.vout, script: input.scriptHex, satoshis: input.satoshis });
    tx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.fromASM(`OP_DUP OP_HASH160 ${recipientPkh} OP_EQUALVERIFY OP_CHECKSIG`),
      satoshis: input.softCapSats,
    }));
    tx.inputs[0].output = new bsv.Transaction.Output({
      script: bsv.Script.fromHex(input.scriptHex),
      satoshis: input.satoshis,
    });

    const sigBuf = Buffer.from(input.sigHex, 'hex');
    if (sigBuf.length < 9) return { ok: false, error: 'pledge signature is malformed' };
    const sighashType = sigBuf[sigBuf.length - 1] as number;
    if (sighashType !== 0xc1) {
      return { ok: false, error: `pledge sighash is 0x${sighashType.toString(16)}, must be 0xc1 (ANYONECANPAY|ALL|FORKID)` };
    }
    const sig = bsv.crypto.Signature.fromDER(sigBuf.subarray(0, sigBuf.length - 1));
    sig.nhashtype = sighashType;
    const verified = bsv.Transaction.sighash.verify(
      tx, sig, bsv.PublicKey.fromString(input.pubkeyHex), 0,
      bsv.Script.fromHex(input.scriptHex), new bsv.crypto.BN(input.satoshis),
    );
    if (!verified) return { ok: false, error: 'pledge signature does not verify against the soft-cap output' };
  } catch (e) {
    return { ok: false, error: `pledge verification failed: ${e instanceof Error ? e.message : 'unknown'}` };
  }
  return { ok: true };
}

/**
 * Flip pledges whose UTXO has been spent to `withdrawn`.
 *
 * Withdrawing is the contributor's only way to revoke a pledge, and nothing used to
 * record that it happened: `getPledgesForAssembly` checked the chain and skipped the
 * spent coin, but `recordPledge` and `getPresaleState` counted it from the database
 * forever. A single withdrawal therefore deadlocked a presale — no replacement pledge
 * could be accepted ("the soft cap is fully pledged") and assembly could never reach
 * the cap — while the public page still advertised the full raise. Run this before any
 * decision that depends on how much is really pledged.
 */
export async function reconcileWithdrawnPledges(saleId: string): Promise<{ withdrawn: number }> {
  const open = await prisma.pledge.findMany({ where: { saleId, state: 'pledged' } });
  const gone: string[] = [];
  for (const p of open) {
    const check = await isOutputUnspent(p.txid, p.vout);
    if (check.unspent === false) gone.push(p.id); // only a DEFINITE spend; null = unknown
  }
  if (gone.length) {
    await prisma.pledge.updateMany({ where: { id: { in: gone } }, data: { state: 'withdrawn' } });
    revalidatePath('/');
  }
  return { withdrawn: gone.length };
}

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
    const sale = await prisma.sale.findUnique({
      where: { id: input.saleId },
      include: { token: { include: { project: true } } },
    });
    if (!sale || sale.type !== 'escrow_presale') return { ok: false, error: 'not an escrow presale' };
    if (sale.status !== 'live') return { ok: false, error: 'presale is not open' };
    if (sale.softCap == null) return { ok: false, error: 'presale has no soft cap' };
    const payoutAddress = sale.token.project.payoutAddress;
    if (!payoutAddress) return { ok: false, error: 'project has no payout address' };

    // Every pledge is one unit, so the assurance output composes exactly. An
    // off-denomination pledge could never be selected without overshooting.
    if (sale.pledgeUnitSats != null && BigInt(Math.floor(input.satoshis)) !== sale.pledgeUnitSats) {
      return { ok: false, error: `a pledge must be exactly ${sale.pledgeUnitSats} sats` };
    }

    // One outpoint, one pledge. Without this a captured payload replays into N
    // soft-cap slots, and legacy `bsv` silently DROPS the duplicate input at
    // assembly — misaligning every unlocking script and killing the broadcast
    // after the fee UTXO has already been minted and spent.
    const dupe = await prisma.pledge.findFirst({ where: { txid: input.txid, vout: input.vout } });
    if (dupe) return { ok: false, error: 'that outpoint is already pledged' };

    const valid = await validatePledgeOnChain({
      txid: input.txid,
      vout: input.vout,
      satoshis: Math.floor(input.satoshis),
      scriptHex: input.scriptHex,
      sigHex: input.sigHex,
      pubkeyHex: input.pubkeyHex,
      softCapSats: Number(sale.softCap),
      projectAddress: payoutAddress,
    });
    if (!valid.ok) return { ok: false, error: valid.error };

    // Count only what is still really pledged — a withdrawn coin must free its slot.
    await reconcileWithdrawnPledges(input.saleId);

    const active = await prisma.pledge.aggregate({
      where: { saleId: input.saleId, state: { in: ['pledged', 'assembled'] } },
      _sum: { satoshis: true },
    });
    const raised = active._sum.satoshis ?? 0n;
    // Pledges fill the assurance contract up to the SOFT cap only — that's the
    // fixed amount every pledge signed over. Beyond it there is nothing to pledge
    // into (over-subscription would strand the pledge). Contributions above the
    // soft cap are the instant-buy phase (ADR-025), not more pledges.
    if (sale.softCap != null && raised + BigInt(input.satoshis) > sale.softCap) {
      return { ok: false, error: 'the soft cap is fully pledged — the presale is ready to assemble' };
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
  const price = Number(sale.priceSats) || 1;

  // Act only on pledges still awaiting assembly. Without this filter a replayed call
  // (two manage tabs, a retried POST) re-created an Order for every pledge — measured
  // at 4 orders for 2 pledges — so the project owed twice the tokens it collected for.
  const assembled = await prisma.pledge.findMany({ where: { id: { in: pledgeIds }, saleId, state: 'pledged' } });
  if (assembled.length === 0) return { ok: true }; // already recorded — nothing to do
  await prisma.$transaction([
    prisma.pledge.updateMany({ where: { id: { in: assembled.map((p) => p.id) } }, data: { state: 'assembled' } }),
    // Keep the sale LIVE — the soft cap is funded, and buyers can now instant-buy
    // the top-up above it, up to the hard cap (ADR-025). The `assured` flag
    // (assembled pledges exist) switches the sale page from pledge → instant buy.
    prisma.event.create({ data: { entity: 'Sale', entityId: saleId, type: 'assurance', payloadHash: assuranceTxid } }),
    // Turn each funded pledge into a settle-eligible Order so token delivery
    // reuses the proven settlement flow (Orders-to-settle tab / SettleOrderButton).
    ...assembled.map((p) =>
      prisma.order.create({
        data: {
          saleId,
          buyerIdentity: p.contributor,
          receiveAddress: p.receiveAddress,
          kind: 'escrow_contribution',
          tokens: BigInt(Math.floor(Number(p.satoshis) / price)),
          satsPaid: p.satoshis,
          state: 'pending',
          paymentTxid: assuranceTxid,
        },
      }),
    ),
  ]);
  revalidatePath('/');
  return { ok: true };
}

/** A presale's aggregate state (raised vs soft/hard cap) for display + assembly. */
export async function getPresaleState(saleId: string): Promise<{
  raisedSats: string;
  pledgeCount: number;
} | null> {
  // Reconcile first: a withdrawn pledge must not be advertised as money raised.
  await reconcileWithdrawnPledges(saleId);
  const agg = await prisma.pledge.aggregate({
    where: { saleId, state: { in: ['pledged', 'assembled'] } },
    _sum: { satoshis: true },
    _count: true,
  });
  return { raisedSats: (agg._sum.satoshis ?? 0n).toString(), pledgeCount: agg._count };
}

/**
 * Record that a contributor reclaimed their pledge. Called after the withdrawal tx
 * built by `withdrawPledge` is broadcast; `reconcileWithdrawnPledges` would catch it
 * anyway on the next read, but recording it immediately keeps the public raise honest
 * without waiting for someone to look.
 */
export async function markPledgeWithdrawn(
  pledgeId: string,
  contributor: string,
  withdrawTxid: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(withdrawTxid)) return { ok: false, error: 'invalid withdrawal txid' };
  const pledge = await prisma.pledge.findUnique({ where: { id: pledgeId } });
  if (!pledge) return { ok: false, error: 'pledge not found' };
  if (pledge.contributor !== contributor) return { ok: false, error: 'not your pledge' };
  if (pledge.state === 'assembled') return { ok: false, error: 'that pledge is already funded' };

  // The chain is the authority — only record a withdrawal that actually happened.
  const check = await isOutputUnspent(pledge.txid, pledge.vout);
  if (check.unspent !== false) return { ok: false, error: 'the pledge UTXO is still unspent' };

  await prisma.pledge.update({ where: { id: pledgeId }, data: { state: 'withdrawn' } });
  await prisma.event.create({
    data: { entity: 'Pledge', entityId: pledgeId, type: 'withdrawn', payloadHash: withdrawTxid },
  });
  revalidatePath('/');
  return { ok: true };
}

/**
 * The connected contributor's still-open pledges for a sale, with everything their
 * own wallet needs to rebuild and sign the reclaim. The derivation nonces are not
 * secrets — spending still requires the contributor's private key, which never
 * leaves their wallet — but they are what makes the coin findable again, so a
 * contributor who cannot reach this data cannot exercise their refund.
 */
export async function getMyPledges(
  saleId: string,
  contributor: string,
): Promise<{
  id: string;
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  derivationPrefix: string;
  derivationSuffix: string;
}[]> {
  if (!contributor) return [];
  await reconcileWithdrawnPledges(saleId);
  const rows = await prisma.pledge.findMany({
    where: { saleId, contributor, state: 'pledged' },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((p) => ({
    id: p.id,
    txid: p.txid,
    vout: p.vout,
    satoshis: Number(p.satoshis),
    scriptHex: p.scriptHex,
    derivationPrefix: p.derivationPrefix ?? '',
    derivationSuffix: p.derivationSuffix ?? '',
  }));
}
