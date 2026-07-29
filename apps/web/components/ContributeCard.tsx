'use client';

import { useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { ShieldCheck } from './ui/icons';
import { useWallet } from './WalletProvider';
import { recordPledge } from '../lib/escrow-actions';
import { broadcastRawTx } from '../lib/settle-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

/**
 * Escrow presale contribute card (ADR-025). A pledge is a SIGHASH_ANYONECANPAY
 * signature over a fixed soft-cap output; the contributor's funds stay in their
 * own wallet until the cap is met and the assurance tx is assembled. Refund and
 * withdraw are automatic/self-service — the platform never holds funds.
 */
export function ContributeCard({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [status, setStatus] = useState<'idle' | 'pledging' | 'pledged'>('idle');
  const [error, setError] = useState<string | null>(null);

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
            ✓ Pledged. Your sats stay in your wallet until the soft cap is met. To withdraw, just spend that coin.
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

      {error && <p className="mt-3 break-words text-xs text-danger">⚠ {error}</p>}

      <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-teal">
        <ShieldCheck width={14} height={14} /> trustless — funds never leave your wallet until the cap is met
      </p>
    </div>
  );
}
