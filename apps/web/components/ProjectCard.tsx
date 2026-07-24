import type { CSSProperties } from 'react';
import Link from 'next/link';
import type { SaleCardVM } from '../lib/types';
import { StatusPill } from './ui';
import { Countdown } from './ui/Countdown';

export function ProjectCard({ s }: { s: SaleCardVM }) {
  return (
    <Link
      href={`/sale/${s.slug}`}
      className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow-1)] transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-2)]"
    >
      <div
        className="relative h-32"
        style={
          {
            '--hue': s.hue,
            backgroundImage: 'linear-gradient(135deg, hsl(var(--hue) 40% 26%), hsl(calc(var(--hue) + 40) 45% 14%))',
          } as CSSProperties
        }
      >
        <span className="absolute right-2.5 top-2.5 rounded-full bg-black/40 px-2.5 py-1 font-mono text-xs font-bold tracking-wide text-white backdrop-blur">
          {s.ticker}
        </span>
        <span className="absolute -bottom-5 left-4 grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-surface font-display font-bold text-fg">
          {s.name.charAt(0)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 pb-4 pt-7">
        <div className="flex items-center justify-between gap-2.5">
          <h3 className="text-[1.05rem] font-semibold">{s.name}</h3>
          <StatusPill status={s.status} />
        </div>
        <p className="m-0 text-sm leading-relaxed text-muted">{s.blurb}</p>

        {s.status !== 'scheduled' && (
          <div>
            <div className="mb-1.5 flex justify-between font-mono text-xs text-muted">
              <span>Sold</span>
              <span>{s.soldPct}%</span>
            </div>
            <div className="progress">
              <i style={{ width: `${s.soldPct}%` }} />
            </div>
          </div>
        )}

        <div className="mt-auto flex items-end justify-between pt-1.5">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Price</span>
            <span className="font-mono text-base font-semibold tabular-nums text-fg">{s.priceSats} sats</span>
          </div>
          {s.countdown ? (
            <Countdown {...s.countdown} />
          ) : (
            <span className="font-mono text-xs text-faint">
              {s.status === 'finalized' ? 'Fully subscribed' : 'Closed'}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
