'use client';

import { Button } from './ui';
import { Wallet } from './ui/icons';
import { useWallet } from './WalletProvider';

function short(pk: string) {
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

/**
 * Header wallet control, backed by the shared WalletProvider. Connecting here
 * connects the whole app — every other component reads the same state, so no
 * further "connect" clicks are needed. Disconnect only happens on click.
 */
export function WalletButton() {
  const { identityKey, network, balance, status, error, connect, disconnect } = useWallet();

  if (identityKey) {
    return (
      <button onClick={disconnect} className="btn btn-secondary" title="Click to disconnect">
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--c-success)' }} />
        <span className="font-mono">{short(identityKey)}</span>
        {balance != null && <span className="font-mono text-muted">· {balance.toLocaleString('en-US')} sats</span>}
        {network === 'testnet' && <span className="font-mono text-warning">testnet</span>}
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
        </div>
      )}
    </div>
  );
}
