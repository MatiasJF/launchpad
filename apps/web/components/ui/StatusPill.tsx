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
  return (
    <span className="pill" style={{ '--tone': tone } as CSSProperties}>
      {status}
    </span>
  );
}
