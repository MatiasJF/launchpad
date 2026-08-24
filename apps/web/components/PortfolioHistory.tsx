'use client';

import { useState, useEffect } from 'react';
import { getPortfolioHistory } from '../lib/portfolio-actions';
import { StatusPill } from './ui';
import type { OrderState } from '@launchpad/core';

interface HistoryItem {
  orderId: string;
  slug: string;
  ticker: string;
  name: string;
  logoUrl: string | null;
  tokens: number;
  satsPaid: number;
  state: string;
  paymentTxid: string | null;
  deliveryTxid: string | null;
  createdAt: Date;
}

export function PortfolioHistory({ identityKey }: { identityKey: string }) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchHistory() {
      setLoading(true);
      try {
        const data = await getPortfolioHistory(identityKey);
        setHistory(data);
      } catch (e) {
        console.error('Failed to fetch history:', e);
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, [identityKey]);

  if (loading) {
    return (
      <div className="grid gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-center gap-3">
              <div className="h-10 w-10 animate-pulse rounded bg-elevated" />
              <div className="flex-1">
                <div className="mb-1 h-4 w-32 animate-pulse rounded bg-elevated" />
                <div className="h-3 w-16 animate-pulse rounded bg-elevated" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="h-10 animate-pulse rounded bg-elevated" />
              <div className="h-10 animate-pulse rounded bg-elevated" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-8 text-center">
        <p className="mb-2 text-base font-semibold">No orders yet</p>
        <p className="text-sm text-muted">Your purchase history will appear here.</p>
        <a href="/#explore" className="mt-4 inline-block text-sm text-teal underline underline-offset-2 hover:opacity-80">
          Explore sales →
        </a>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-[0.08em] text-faint">
              <th className="pb-3 pr-4">Date</th>
              <th className="pb-3 pr-4">Token</th>
              <th className="pb-3 pr-4 text-right">Amount</th>
              <th className="pb-3 pr-4 text-right">Paid (sats)</th>
              <th className="pb-3 pr-4">Status</th>
              <th className="pb-3">Proof</th>
            </tr>
          </thead>
          <tbody>
            {history.map((item) => (
              <tr key={item.orderId} className="border-b border-line last:border-b-0">
                <td className="py-4 pr-4 text-sm text-muted">
                  {new Date(item.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </td>
                <td className="py-4 pr-4">
                  <a
                    href={`/sale/${item.slug}`}
                    className="flex items-center gap-2 transition hover:opacity-80"
                  >
                    {item.logoUrl ? (
                      <img src={item.logoUrl} alt={item.ticker} className="h-8 w-8 rounded object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-elevated font-mono text-xs text-faint">
                        {item.ticker.slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium">{item.name}</div>
                      <div className="font-mono text-xs text-muted">{item.ticker}</div>
                    </div>
                  </a>
                </td>
                <td className="py-4 pr-4 text-right font-mono text-sm tabular-nums">
                  {item.tokens.toLocaleString('en-US')}
                </td>
                <td className="py-4 pr-4 text-right font-mono text-sm tabular-nums">
                  {item.satsPaid.toLocaleString('en-US')}
                </td>
                <td className="py-4 pr-4">
                  <StatusPill status={item.state as OrderState} />
                </td>
                <td className="py-4">
                  <div className="flex gap-2">
                    {item.paymentTxid && (
                      <a
                        href={`https://whatsonchain.com/tx/${item.paymentTxid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-teal underline underline-offset-2 hover:opacity-80"
                        title="Payment transaction"
                      >
                        Pay ↗
                      </a>
                    )}
                    {item.deliveryTxid && (
                      <a
                        href={`https://whatsonchain.com/tx/${item.deliveryTxid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-teal underline underline-offset-2 hover:opacity-80"
                        title="Token delivery transaction"
                      >
                        Delivery ↗
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card layout */}
      <div className="grid gap-4 lg:hidden">
        {history.map((item) => (
          <div key={item.orderId} className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <a
                href={`/sale/${item.slug}`}
                className="flex items-center gap-2 transition hover:opacity-80"
              >
                {item.logoUrl ? (
                  <img src={item.logoUrl} alt={item.ticker} className="h-10 w-10 rounded object-cover" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-elevated font-mono text-xs text-faint">
                    {item.ticker.slice(0, 2)}
                  </div>
                )}
                <div>
                  <div className="font-medium">{item.name}</div>
                  <div className="font-mono text-xs text-muted">{item.ticker}</div>
                </div>
              </a>
              <StatusPill status={item.state as OrderState} />
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <div className="text-xs text-faint">Amount</div>
                <div className="font-mono tabular-nums">{item.tokens.toLocaleString('en-US')}</div>
              </div>
              <div>
                <div className="text-xs text-faint">Paid</div>
                <div className="font-mono tabular-nums">{item.satsPaid.toLocaleString('en-US')} sats</div>
              </div>
              <div>
                <div className="text-xs text-faint">Date</div>
                <div className="text-muted">
                  {new Date(item.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </div>
              </div>
              <div>
                <div className="text-xs text-faint">Proof</div>
                <div className="flex gap-2">
                  {item.paymentTxid && (
                    <a
                      href={`https://whatsonchain.com/tx/${item.paymentTxid}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-teal underline underline-offset-2 hover:opacity-80"
                      title="Payment transaction"
                    >
                      Pay ↗
                    </a>
                  )}
                  {item.deliveryTxid && (
                    <a
                      href={`https://whatsonchain.com/tx/${item.deliveryTxid}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-teal underline underline-offset-2 hover:opacity-80"
                      title="Token delivery transaction"
                    >
                      Delivery ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
