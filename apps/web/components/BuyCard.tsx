'use client';

import { useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { Countdown } from './ui/Countdown';
import { ShieldCheck } from './ui/icons';
import { BuyModal } from './BuyModal';

export function BuyCard({ s }: { s: SaleCardVM }) {
  const [modalOpen, setModalOpen] = useState(false);
  const open = s.saleState === 'open';
  const scheduled = s.saleState === 'upcoming';

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow-2)]">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, var(--c-gold), transparent)' }}
      />
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Price per token</span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-fg">{s.priceSats} sats</span>
        </div>
        <StatusPill status={s.status} />
      </div>

      {s.status !== 'scheduled' && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between font-mono text-xs text-muted">
            <span>Sold</span>
            <span>{s.soldPct}%</span>
          </div>
          <div className="progress">
            <i style={{ width: `${s.soldPct}%` }} />
          </div>
        </div>
      )}

      {s.countdown && (
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.08em] text-faint">
            {scheduled ? 'Starts in' : 'Ends in'}
          </div>
          <Countdown {...s.countdown} />
        </div>
      )}

      <div className="mt-5">
        {open ? (
          <Button variant="primary" block onClick={() => setModalOpen(true)}>
            Buy on mainnet
          </Button>
        ) : scheduled ? (
          <Button variant="secondary" block disabled>
            Not open yet
          </Button>
        ) : (
          <Button variant="secondary" block disabled>
            Sale ended
          </Button>
        )}
      </div>

      <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-teal">
        <ShieldCheck width={14} height={14} /> settlement is SPV-verifiable
      </p>

      <BuyModal s={s} isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
