import type { Allocation } from '../../lib/seed';

const COLORS = ['var(--c-gold)', 'var(--c-teal)', 'var(--c-info)', '#8b7bd8', 'var(--c-muted)'];

export function TokenomicsBar({ allocations }: { allocations: Allocation[] }) {
  return (
    <div>
      <div className="flex h-9 overflow-hidden rounded-md border border-line">
        {allocations.map((a, i) => (
          <div
            key={a.label}
            className="flex items-center justify-center font-mono text-[0.7rem] font-bold text-black/75"
            style={{ width: `${a.pct}%`, background: COLORS[i % COLORS.length] }}
          >
            {a.pct >= 12 ? `${a.pct}%` : ''}
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3">
        {allocations.map((a, i) => (
          <div key={a.label} className="flex items-center gap-2 text-sm">
            <span className="h-3 w-3 flex-none rounded" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="text-muted">{a.label}</span>
            <span className="ml-auto font-mono tabular-nums text-fg">{a.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
