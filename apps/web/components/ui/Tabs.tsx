'use client';

import { useState, type ReactNode } from 'react';

/** Underline tab bar. Renders only the active tab's content. */
export function Tabs({ tabs }: { tabs: { id: string; label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return (
    <div>
      <div className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              active === t.id ? 'border-gold text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">{tabs.find((t) => t.id === active)?.content}</div>
    </div>
  );
}
