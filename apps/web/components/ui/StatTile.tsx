import type { ReactNode } from 'react';

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat-tile">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}
