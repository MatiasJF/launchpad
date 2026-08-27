import type { CSSProperties } from 'react';
import type { OrderState, SaleStatus } from '@launchpad/core';

const TONE: Record<string, string> = {
  // sale states
  scheduled: 'var(--status-scheduled)',
  live: 'var(--status-live)',
  finalized: 'var(--status-finalized)',
  failed: 'var(--status-failed)',
  // order states
  pending: 'var(--info)',
  settled: 'var(--teal)',
  refunded: 'var(--warning)',
  withdrawn: 'var(--warning)',
};

export function StatusPill({ status }: { status: SaleStatus | OrderState }) {
  const tone = TONE[status] ?? 'var(--info)';
  const isLive = status === 'live';

  return (
    // `pill-live` suppresses the static `.pill::before` dot so only the pulsing dot below shows.
    <span className={`pill${isLive ? ' pill-live' : ''}`} style={{ '--tone': tone } as CSSProperties}>
      {isLive && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-live)]" />
      )}
      {status === 'finalized' ? 'Completed' : status}
    </span>
  );
}
