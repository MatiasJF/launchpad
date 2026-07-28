'use client';

import { useEffect, useState } from 'react';
import { Button } from './ui';
import { getBuyerClaimableOrders, markOrderRegistered } from '../lib/order-actions';
import { getSourceBeef } from '../lib/settle-actions';
import { useWallet } from './WalletProvider';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

type Claimable = {
  orderId: string;
  txid: string;
  tokens: string;
  slug: string;
  ticker: string;
  projectName: string;
};

type RowState = { phase: string; result?: 'registered' | 'already' | 'error'; message?: string };

/**
 * Buyer-facing claim panel. After the operator settles an order the tokens are
 * on-chain at the buyer's address, but the wallet doesn't track them yet — this
 * registers them (internalize as a STAS basket insertion) so they render and
 * become spendable. Non-custodial: runs in the buyer's own wallet.
 */
export function ClaimTokens({ slug }: { slug: string }) {
  const { identityKey, connect } = useWallet();
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [orders, setOrders] = useState<Claimable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  async function load(identity: string) {
    setStatus('loading');
    setError(null);
    try {
      const all = await getBuyerClaimableOrders(identity);
      setOrders(all.filter((o) => o.slug === slug));
      setStatus('loaded');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  }

  // Once the (shared) wallet is connected, load this buyer's claimable orders —
  // no separate connect click needed here.
  useEffect(() => {
    if (identityKey && status === 'idle') void load(identityKey);
  }, [identityKey]);

  async function connectAndLoad() {
    const id = identityKey ?? (await connect());
    if (id) void load(id);
  }

  async function register(o: Claimable) {
    setRows((r) => ({ ...r, [o.orderId]: { phase: 'fetching transfer BEEF' } }));
    try {
      // Discovery-scan path: the buyer doesn't hold the transfer BEEF, so fetch
      // the settlement tx's BEEF from-chain. Null = not confirmed yet.
      const beef = await getSourceBeef(o.txid);
      if (!beef) {
        setRows((r) => ({
          ...r,
          [o.orderId]: { phase: '', result: 'error', message: 'settlement tx not confirmed yet — try again in a few minutes' },
        }));
        return;
      }

      setRows((r) => ({ ...r, [o.orderId]: { phase: 'registering in wallet (approve if prompted)' } }));
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { receiveStasToken } = await import('@launchpad/bsv/receive');
      const wallet = await getWalletClient();

      const customInstructions = JSON.stringify({
        protocolID: STAS_PROTOCOL,
        keyID: o.slug,
        counterparty: 'self',
        ticker: o.ticker,
        tokens: o.tokens,
      });

      const res = await receiveStasToken(wallet as never, {
        txid: o.txid,
        vout: 0, // recipient token output is always TX2:0
        atomicBeef: beef,
        customInstructions,
        tags: ['launchpad', o.slug],
      });
      // eslint-disable-next-line no-console
      console.log('[claim] receiveStasToken result:', res);

      if (res.registered) {
        await markOrderRegistered(o.orderId); // won't re-appear on reload
        setRows((r) => ({ ...r, [o.orderId]: { phase: '', result: 'registered' } }));
      } else if (res.reason === 'already registered') {
        await markOrderRegistered(o.orderId);
        setRows((r) => ({ ...r, [o.orderId]: { phase: '', result: 'already' } }));
      } else {
        setRows((r) => ({ ...r, [o.orderId]: { phase: '', result: 'error', message: res.reason ?? 'registration failed' } }));
      }
    } catch (e) {
      setRows((r) => ({
        ...r,
        [o.orderId]: { phase: '', result: 'error', message: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Your tokens</span>
          <span className="text-sm text-muted">Register settled purchases into your wallet</span>
        </div>
        {status !== 'loaded' && (
          <Button variant="secondary" onClick={connectAndLoad} disabled={status === 'loading'}>
            {status === 'loading' ? 'Checking…' : 'Check my orders'}
          </Button>
        )}
      </div>

      {error && <p className="mt-3 break-words text-xs text-danger">⚠ {error}</p>}

      {status === 'loaded' && orders.length === 0 && (
        <p className="mt-3 text-sm text-muted">No settled orders to register for this sale yet.</p>
      )}

      {orders.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {orders.map((o) => {
            const row = rows[o.orderId];
            return (
              <li key={o.orderId} className="flex flex-col gap-1 rounded-md border border-line bg-elevated p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm text-fg">
                    {Number(o.tokens).toLocaleString('en-US')} {o.ticker}
                  </span>
                  {row?.result === 'registered' ? (
                    <span className="font-mono text-xs text-teal">✓ registered in wallet</span>
                  ) : row?.result === 'already' ? (
                    <span className="font-mono text-xs text-muted">✓ already in wallet</span>
                  ) : (
                    <Button variant="primary" onClick={() => register(o)} disabled={!!row && !row.result}>
                      {row && !row.result ? 'Registering…' : 'Register in wallet'}
                    </Button>
                  )}
                </div>
                <a
                  href={`https://whatsonchain.com/tx/${o.txid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[0.65rem] text-faint underline underline-offset-2"
                >
                  {o.txid.slice(0, 18)}… ↗
                </a>
                {row && !row.result && row.phase && <p className="font-mono text-xs text-muted">⏳ {row.phase}…</p>}
                {row?.result === 'error' && <p className="break-words text-xs text-danger">⚠ {row.message}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
