'use client';

import { useState, useEffect } from 'react';
import { getPortfolioHoldings } from '../lib/portfolio-actions';

interface Holding {
  slug: string;
  ticker: string;
  name: string;
  logoUrl: string | null;
  tokens: number;
  latestTxid: string | null;
}

export function PortfolioHoldings({ identityKey }: { identityKey: string }) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchHoldings() {
      setLoading(true);
      const startTime = Date.now();
      try {
        const data = await getPortfolioHoldings(identityKey);
        // Minimum 500ms loading time for smooth skeleton transition
        const elapsed = Date.now() - startTime;
        if (elapsed < 500) {
          await new Promise((resolve) => setTimeout(resolve, 500 - elapsed));
        }
        setHoldings(data);
      } catch (e) {
        console.error('Failed to fetch holdings:', e);
      } finally {
        setLoading(false);
      }
    }
    fetchHoldings();
  }, [identityKey]);

  if (loading) {
    return (
      <div className="grid gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-5">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 animate-pulse rounded-lg bg-elevated" />
              <div className="flex-1">
                <div className="mb-2 h-5 w-32 animate-pulse rounded bg-elevated" />
                <div className="h-8 w-24 animate-pulse rounded bg-elevated" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-8 text-center">
        <p className="mb-2 text-base font-semibold">No tokens yet</p>
        <p className="text-sm text-muted">
          Your delivered tokens will appear here. Explore sales to get started.
        </p>
        <a href="/#explore" className="mt-4 inline-block text-sm text-teal underline underline-offset-2 hover:opacity-80">
          Explore sales →
        </a>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {holdings.map((h) => (
        <div key={h.slug} className="rounded-lg border border-line bg-surface p-5">
          <div className="flex items-start gap-4">
            {/* Logo */}
            {h.logoUrl ? (
              <img src={h.logoUrl} alt={h.ticker} className="h-12 w-12 rounded-lg object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-elevated font-mono text-xs text-faint">
                {h.ticker.slice(0, 2)}
              </div>
            )}

            {/* Token info */}
            <div className="flex-1">
              <div className="flex items-baseline gap-2">
                <h3 className="font-semibold">{h.name}</h3>
                <span className="font-mono text-sm text-muted">{h.ticker}</span>
              </div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="font-mono text-2xl font-semibold tabular-nums text-gold">
                  {h.tokens.toLocaleString('en-US')}
                </span>
                <span className="text-sm text-muted">tokens</span>
              </div>
              {h.latestTxid && (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                  <span>Latest delivery:</span>
                  <a
                    href={`https://whatsonchain.com/tx/${h.latestTxid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-teal underline underline-offset-2 hover:opacity-80"
                  >
                    {h.latestTxid.slice(0, 8)}...{h.latestTxid.slice(-8)} ↗
                  </a>
                </div>
              )}
            </div>

            {/* View project link */}
            <a
              href={`/sale/${h.slug}`}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg"
            >
              View project
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
