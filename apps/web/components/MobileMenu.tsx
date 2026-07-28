'use client';

import { useState } from 'react';

const links = [
  { label: 'Explore', href: '/#explore' },
  { label: 'Submit', href: '/submit' },
  { label: 'Docs', href: '#' },
];

/** Mobile nav drawer — the < sm counterpart to the header's inline nav. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);

  return (
    <div className="sm:hidden">
      <button
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="btn btn-ghost px-2.5"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {open ? (
            <>
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </>
          ) : (
            <>
              <path d="M3 6h18" />
              <path d="M3 12h18" />
              <path d="M3 18h18" />
            </>
          )}
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setOpen(false)} />
          <nav className="glass absolute right-4 top-[60px] z-50 flex w-48 flex-col gap-1 rounded-lg p-2 shadow-[var(--shadow-2)]">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2.5 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
