'use client';

import { useState } from 'react';
import type { SaleStatus } from '@launchpad/core';
import type { SaleCardVM } from '../lib/types';
import { ProjectCard } from './ProjectCard';

const FILTERS: { key: 'all' | SaleStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'scheduled', label: 'Upcoming' },
  { key: 'finalized', label: 'Finalized' },
];

export function ExploreSection({ sales }: { sales: SaleCardVM[] }) {
  const [active, setActive] = useState<'all' | SaleStatus>('all');
  const items = active === 'all' ? sales : sales.filter((s) => s.status === active);

  return (
    <section id="explore" className="mx-auto max-w-[1120px] px-4 pb-20 pt-10 sm:px-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <span className="font-mono text-xs uppercase tracking-[0.18em] text-gold">Explore</span>
          <h2 className="mt-1 text-[1.75rem] font-semibold">Token sales</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f.key} className="chip" data-active={active === f.key} onClick={() => setActive(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-8 text-center text-muted">No sales in this view yet.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 sm:gap-[18px]">
          {items.map((s, i) => (
            <ProjectCard key={s.slug} s={s} index={i} />
          ))}
        </div>
      )}
    </section>
  );
}
