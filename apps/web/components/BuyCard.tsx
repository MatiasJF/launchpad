'use client';

import { useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { Countdown } from './ui/Countdown';
import { ShieldCheck } from './ui/icons';

export function BuyCard({ s }: { s: SaleCardVM }) {
  const [amount, setAmount] = useState(1000);
  const tokens = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const cost = tokens * s.priceSats;
  const live = s.status === 'live';
  const scheduled = s.status === 'scheduled';

  return (
    <div className="sticky top-20 rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow-1)]">
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

      {live && (
        <div className="mt-4">
          <label className="mb-1.5 block font-mono text-xs uppercase tracking-[0.08em] text-faint">
            Amount ({s.ticker})
          </label>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-full rounded-md border border-line bg-elevated px-3 py-2.5 font-mono tabular-nums text-fg outline-none transition focus:border-gold"
          />
          <div className="mt-2 flex justify-between font-mono text-sm">
            <span className="text-muted">Total</span>
            <span className="tabular-nums text-fg">{cost.toLocaleString('en-US')} sats</span>
          </div>
        </div>
      )}

      <div className="mt-5">
        {live && (
          <Button variant="primary" block>
            Buy on mainnet
          </Button>
        )}
        {scheduled && (
          <Button variant="secondary" block>
            Notify me
          </Button>
        )}
        {s.status === 'finalized' && (
          <Button variant="secondary" block disabled>
            Sale ended
          </Button>
        )}
        {s.status === 'failed' && (
          <Button variant="secondary" block disabled>
            Sale failed
          </Button>
        )}
      </div>

      <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-teal">
        <ShieldCheck width={14} height={14} /> settlement is SPV-verifiable
      </p>
    </div>
  );
}
