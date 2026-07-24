import type { ReactNode } from 'react';

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">{label}</span>
      <span className="font-mono text-xl font-semibold tabular-nums text-fg">{value}</span>
    </div>
  );
}
