'use client';

import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { MintPlan } from '@launchpad/bsv/issue';
import { Button } from './ui';
import { buildMintPlan, recordIssuance } from '../lib/mint';
import { broadcastRawTx } from '../lib/settle-actions';

// Canonical STAS BRC-42 protocol id (ADR-021). Hardcoded here so the client
// never imports @launchpad/bsv (which pulls the heavy bsv/stas-js libs).
const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.local';

type Status = 'idle' | 'planning' | 'confirming' | 'minting' | 'done';

function fmt(n: number) {
  return n.toLocaleString('en-US');
}

export function IssueButton({
  projectId,
  ticker,
  supply,
  slug,
}: {
  projectId: string;
  ticker: string;
  supply: number;
  slug: string;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [plan, setPlan] = useState<MintPlan | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // WalletClient instance is not serializable — hold it across plan → confirm → mint.
  const walletRef = useRef<unknown>(null);

  const symbol = ticker.replace(/^\$/, '');

  async function plan_() {
    setError(null);
    setStatus('planning');
    try {
      const { WalletClient } = await import('@bsv/sdk');
      const wallet = new WalletClient('auto', ORIGINATOR);
      walletRef.current = wallet;
      await wallet.waitForAuthentication({});
      const owner = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: `${slug}-owner`, counterparty: 'self' });
      const redeem = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: `${slug}-redeem`, counterparty: 'self' });
      const p = await buildMintPlan({ symbol, supply }, owner.publicKey, redeem.publicKey);
      setPlan(p);
      setStatus('confirming');
    } catch (e) {
      setError(msg(e));
      setStatus('idle');
    }
  }

  async function confirm_() {
    if (!plan) return;
    setStatus('minting');
    setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wallet = walletRef.current as any;
      // Genesis mint = CONTRACT → ISSUE (so WoC back-to-genesis reads it as
      // authentic, not counterfeit). Non-custodial: the wallet signs both txs.
      const { issueStasGenesis } = await import('@launchpad/bsv/genesis');
      const res = await issueStasGenesis(wallet, '', 'main', { slug, symbol, supply, splittable: true });
      if (!res.ok) throw new Error(res.reason);

      // Broadcast CONTRACT first (the issue tx spends it), then ISSUE — to the
      // same node, since createAction doesn't reliably propagate.
      const bc1 = await broadcastRawTx(res.contractRawTx, res.contractTxid);
      if (!bc1.ok) throw new Error(`contract broadcast rejected: ${bc1.error}`);
      const bc2 = await broadcastRawTx(res.issueRawTx, res.genesisTxid);
      if (!bc2.ok) throw new Error(`issue broadcast rejected: ${bc2.error}`);

      const genesis = bc2.txid || res.genesisTxid;
      await recordIssuance(projectId, genesis, res.tokenId);
      setTxid(genesis);
      setStatus('done');
    } catch (e) {
      setError(msg(e));
      setStatus('confirming');
    }
  }

  if (status === 'done' && txid) {
    return (
      <a
        href={`https://whatsonchain.com/tx/${txid}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs text-teal underline underline-offset-2"
      >
        ✓ issued · {txid.slice(0, 10)}…
      </a>
    );
  }

  return (
    <>
      <Button variant="primary" onClick={plan_} disabled={status === 'planning'}>
        {status === 'planning' ? 'Preparing…' : 'Issue token'}
      </Button>

      {(status === 'confirming' || status === 'minting') && plan && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4" onClick={() => setStatus('idle')}>
          <div
            className="w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-[var(--shadow-2)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold">Issue {symbol} on mainnet</h3>
            <p className="mt-1 text-sm text-muted">
              This broadcasts a real STAS issuance transaction. 1 satoshi = 1 token, so the supply is locked as satoshis.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Row label="Supply" value={`${fmt(plan.supply)} ${symbol}`} />
              <Row label="Sats to lock" value={fmt(plan.tokenSatoshis)} />
              <Row label="Est. fee" value={fmt(plan.estFeeSats)} />
              <Row label="Total needed" value={`${fmt(plan.totalSatsRequired)} sats`} strong />
            </div>
            <div className="mt-3 rounded-md border border-line bg-elevated p-2.5">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">Token id</span>
              <div className="break-all font-mono text-xs text-fg">{plan.tokenId}</div>
            </div>
            {error && <p className="mt-3 text-sm text-danger">{error}</p>}
            <div className="mt-5 flex gap-2">
              <Button variant="primary" block onClick={confirm_} disabled={status === 'minting'}>
                {status === 'minting' ? 'Minting…' : 'Confirm & broadcast'}
              </Button>
              <Button variant="secondary" onClick={() => setStatus('idle')} disabled={status === 'minting'}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && status === 'idle' && <p className="mt-1 text-xs text-danger">{error}</p>}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">{label}</span>
      <span
        className="font-mono tabular-nums text-fg"
        style={strong ? ({ color: 'var(--c-gold)', fontWeight: 600 } as CSSProperties) : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function msg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes('No wallet available')) return 'No BSV wallet found. Open BSV Desktop and try again.';
  if (/insufficient|not enough|funds/i.test(m)) return 'Insufficient funds in the wallet to lock this supply as satoshis.';
  return m;
}
