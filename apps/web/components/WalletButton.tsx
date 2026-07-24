'use client';

import { useState } from 'react';
import type { WalletIdentity } from '@launchpad/bsv';
import { Button } from './ui';
import { Wallet } from './ui/icons';

function short(pk: string) {
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('No wallet available')
    ? 'No BSV wallet found. Open BSV Desktop (or another BRC-100 wallet) and try again.'
    : m;
}

type Status = 'idle' | 'connecting' | 'connected';

export function WalletButton() {
  const [id, setId] = useState<WalletIdentity | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setStatus('connecting');
    setError(null);
    try {
      // Lazy-load the BSV SDK so it stays out of the initial bundle.
      const { connectWallet, getBalanceSats } = await import('@launchpad/bsv');
      const identity = await connectWallet();
      setId(identity);
      setStatus('connected');
      try {
        setBalance(await getBalanceSats());
      } catch {
        setBalance(null);
      }
    } catch (e) {
      setError(errMsg(e));
      setStatus('idle');
    }
  }

  function disconnect() {
    setId(null);
    setBalance(null);
    setStatus('idle');
  }

  if (status === 'connected' && id) {
    return (
      <button onClick={disconnect} className="btn btn-secondary" title="Click to disconnect">
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--c-success)' }} />
        <span className="font-mono">{short(id.identityPubkey)}</span>
        {balance != null && <span className="font-mono text-muted">· {balance.toLocaleString('en-US')} sats</span>}
        {id.network === 'testnet' && <span className="font-mono text-warning">testnet</span>}
      </button>
    );
  }

  return (
    <div className="relative">
      <Button variant="secondary" onClick={connect} disabled={status === 'connecting'}>
        <Wallet /> {status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
      </Button>
      {error && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 rounded-md border border-line bg-surface p-3 text-xs leading-relaxed text-muted shadow-[var(--shadow-2)]">
          {error}
          <button
            onClick={() => setError(null)}
            className="mt-2 block font-mono text-faint transition hover:text-fg"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
