'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { ShieldCheck } from './ui/icons';
import { useWallet } from './WalletProvider';
import { getMyPledges, markPledgeWithdrawn, recordPledge } from '../lib/escrow-actions';
import { broadcastRawTx, getSourceBeefDeep } from '../lib/settle-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

/** 1-in/1-out P2PKH reclaim is ~192 B; 30 sats is ~0.16 sat/B, well over the floor. */
const WITHDRAW_FEE_SATS = 30;

type MyPledge = Awaited<ReturnType<typeof getMyPledges>>[number];

/**
 * Escrow presale contribute card (ADR-025). A pledge is a SIGHASH_ANYONECANPAY
 * signature over a fixed soft-cap output; the contributor's funds stay in their
 * own wallet until the cap is met and the assurance tx is assembled.
 *
 * Withdrawal is offered explicitly rather than left to the wallet. A pledge signature
 * is a STANDING authorisation — ANYONECANPAY binds only the contributor's own input
 * and the fixed output, so it never expires and is not conditional on the soft cap
 * actually being reached by others. Spending the coin is the contributor's ONLY way
 * to revoke it, which makes the reclaim a first-class control, not a footnote.
 */
export function ContributeCard({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [status, setStatus] = useState<'idle' | 'pledging' | 'pledged'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<MyPledge[]>([]);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState<{ txid: string; sats: number; adopted: boolean; why?: string } | null>(null);

  const refreshMine = useCallback(async () => {
    try {
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      setMine(await getMyPledges(s.saleId, identity));
    } catch {
      /* not connected yet — nothing to show */
    }
  }, [s.saleId]);

  useEffect(() => {
    void refreshMine();
  }, [refreshMine]);

  async function withdraw(p: MyPledge) {
    setWithdrawing(p.id);
    setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { withdrawPledge, internalizePledgeRefund } = await import('@launchpad/bsv/pledge');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      // The wallet must be able to validate the output it is asked to take custody of.
      const sourceBeef = await getSourceBeefDeep(p.txid);
      if (!sourceBeef) throw new Error('could not load the pledge ancestry needed to reclaim it — try again shortly');

      const built = await withdrawPledge(wallet as never, 'main', {
        utxo: {
          txid: p.txid,
          vout: p.vout,
          satoshis: p.satoshis,
          scriptHex: p.scriptHex,
          derivationPrefix: p.derivationPrefix,
          derivationSuffix: p.derivationSuffix,
        },
        feeSats: WITHDRAW_FEE_SATS,
        sourceBeef,
      });
      if (!built.ok) throw new Error(built.reason);

      const bc = await broadcastRawTx(built.rawTx, built.txid);
      if (!bc.ok) throw new Error(`withdrawal rejected: ${bc.error}`);
      const txid = bc.txid || built.txid;

      // Broadcasting moves the coin; internalising is what puts it back in the wallet's
      // balance. Without this the sats sit at a key the wallet can derive but has never
      // adopted — the owner's money, invisible to the owner. Not fatal if it fails: the
      // funds are safely on-chain, so say so plainly rather than reporting a clean win.
      const adopted = await internalizePledgeRefund(wallet as never, built.refund);
      await markPledgeWithdrawn(p.id, identity, txid);
      setWithdrawn({ txid, sats: built.reclaimedSats, adopted: adopted.ok, why: adopted.reason });
      setStatus('idle');
      await refreshMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWithdrawing(null);
    }
  }

  const open = s.saleState === 'open';
  const softPct = s.softCapSats > 0 ? Math.min(100, Math.round((s.raisedSats / s.softCapSats) * 100)) : 0;
  const capReached = s.softCapSats > 0 && s.raisedSats >= s.softCapSats;
  const unitTokens = s.priceSats > 0 ? Math.floor(s.pledgeUnitSats / s.priceSats) : 0;

  async function pledge() {
    setStatus('pledging');
    setError(null);
    try {
      if (!s.payoutAddress) throw new Error('this presale has no payout address configured');
      if (s.pledgeUnitSats <= 0) throw new Error('presale pledge unit not configured');
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { createPledge } = await import('@launchpad/bsv/pledge');
      const { PublicKey } = await import('@bsv/sdk');
      const wallet = await getWalletClient();

      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const { publicKey: ownerPub } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self' });
      const receiveAddress = PublicKey.fromString(ownerPub).toAddress().toString();

      const res = await createPledge(wallet as never, 'main', {
        pledgeUnitSats: s.pledgeUnitSats,
        softCapSats: s.softCapSats,
        projectAddress: s.payoutAddress,
      });
      if (!res.ok) throw new Error(res.reason);

      // Broadcast the pledge's funding tx so the UTXO exists on-chain (the signed
      // input references it). Funds are still the contributor's — only the assurance
      // tx (later, on success) actually moves them.
      const bc = await broadcastRawTx(res.fundingRawTx, res.utxo.txid);
      if (!bc.ok) throw new Error(`pledge funding broadcast rejected: ${bc.error}`);

      const r = await recordPledge({
        saleId: s.saleId,
        contributor: identity,
        receiveAddress,
        txid: res.utxo.txid,
        vout: res.utxo.vout,
        satoshis: res.utxo.satoshis,
        scriptHex: res.utxo.scriptHex,
        sigHex: res.sigHex,
        pubkeyHex: res.pubkeyHex,
        derivationPrefix: res.utxo.derivationPrefix,
        derivationSuffix: res.utxo.derivationSuffix,
      });
      if (!r.ok) throw new Error(r.error);
      setStatus('pledged');
      await refreshMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow-2)]">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, var(--c-violet), transparent)' }}
      />
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Escrow presale</span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-fg">
            {s.pledgeUnitSats.toLocaleString('en-US')} sats
          </span>
          <span className="font-mono text-xs text-muted">per pledge{unitTokens > 0 ? ` · ${unitTokens} ${s.ticker}` : ''}</span>
        </div>
        <StatusPill status={s.status} />
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex justify-between font-mono text-xs">
          <span className="text-muted">Pledged</span>
          <span className="tabular-nums text-fg">
            {s.raisedSats.toLocaleString('en-US')} / {s.softCapSats.toLocaleString('en-US')} soft
          </span>
        </div>
        <div className="progress">
          <i style={{ width: `${softPct}%` }} />
        </div>
        <p className="mt-1 font-mono text-[0.65rem] text-faint">
          hard cap {s.hardCapSats.toLocaleString('en-US')} sats · {capReached ? 'soft cap reached ✓' : `${softPct}% of soft cap`}
        </p>
      </div>

      <div className="mt-5">
        {status === 'pledged' ? (
          <div className="rounded-md border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">
            ✓ Pledged. Your sats stay in your wallet — withdraw below any time to take the pledge back.
          </div>
        ) : capReached ? (
          <Button variant="secondary" block disabled>
            Soft cap fully pledged
          </Button>
        ) : open ? (
          <Button variant="primary" block onClick={pledge} disabled={status === 'pledging'}>
            {status === 'pledging' ? 'Pledging…' : `Pledge ${s.pledgeUnitSats.toLocaleString('en-US')} sats`}
          </Button>
        ) : (
          <Button variant="secondary" block disabled>
            {s.saleState === 'upcoming' ? 'Not open yet' : 'Presale ended'}
          </Button>
        )}
      </div>

      {mine.length > 0 && (
        <div className="mt-4 rounded-md border border-line bg-bg/40 p-3">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">
            Your pledges — reclaim any time before the cap is assembled
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {mine.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs tabular-nums text-muted">
                  {p.satoshis.toLocaleString('en-US')} sats
                  <span className="text-faint"> · {p.txid.slice(0, 10)}…:{p.vout}</span>
                </span>
                <Button
                  variant="secondary"
                  onClick={() => withdraw(p)}
                  disabled={withdrawing !== null}
                >
                  {withdrawing === p.id ? 'Withdrawing…' : 'Withdraw'}
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-[0.65rem] leading-relaxed text-faint">
            Withdrawing spends your own coin, which voids the pledge — the only way to take it back.
            Costs {WITHDRAW_FEE_SATS} sats in fees.
          </p>
        </div>
      )}

      {withdrawn && (
        <div className="mt-3 break-words font-mono text-xs">
          <p className={withdrawn.adopted ? 'text-teal' : 'text-warning'}>
            ✓ Withdrawn — {withdrawn.sats.toLocaleString('en-US')} sats · {withdrawn.txid.slice(0, 16)}…
          </p>
          <p className="mt-1 text-[0.65rem] leading-relaxed text-faint">
            {withdrawn.adopted
              ? 'Your wallet has taken the coin back into its balance.'
              : `On-chain and yours, but your wallet has not adopted it yet${withdrawn.why ? ` (${withdrawn.why})` : ''}, so it may not show in your balance. The funds are safe — the transaction above pays a key your wallet derives.`}
          </p>
        </div>
      )}

      {error && <p className="mt-3 break-words text-xs text-danger">⚠ {error}</p>}

      <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-teal">
        <ShieldCheck width={14} height={14} /> non-custodial — your sats stay in your own wallet
      </p>
      <p className="mt-1 font-mono text-[0.65rem] leading-relaxed text-faint">
        A pledge fixes where your sats can go — only this project&rsquo;s payout address, never anywhere
        else. It does not fix when: the signature stays valid until you withdraw, and the deadline is
        enforced by this app, not by the blockchain.
      </p>
    </div>
  );
}
