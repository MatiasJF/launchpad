'use client';

import { useState } from 'react';

/**
 * Collapsible SPV explainer for the Buy tab.
 * Explains instant finality + proof portability without jargon.
 */
export function SpvExplainer() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-4 text-left text-sm font-medium text-fg transition hover:bg-elevated/30"
      >
        <span className="flex items-center gap-2">
          <svg className="h-4 w-4 text-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          What is SPV?
        </span>
        <svg
          className={`h-4 w-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-line p-4 text-sm text-muted">
          <p className="mb-3">
            <strong className="text-fg">SPV (Simplified Payment Verification)</strong> means your trade is verifiable
            independently — you don't have to trust us.
          </p>
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong className="text-fg">Instant finality:</strong> BSV transactions confirm in seconds, not minutes.
              Your tokens are yours the moment the transaction is mined.
            </li>
            <li>
              <strong className="text-fg">Portable proof:</strong> After your purchase, you can download a BEEF file —
              a cryptographic proof that your trade happened. It's verifiable offline, independently, forever.
            </li>
            <li>
              <strong className="text-fg">No global state:</strong> BSV has no global mempool, so there's no
              front-running or MEV. Your transaction settles in the order it was received, fairly and transparently.
            </li>
          </ul>
          <p className="mt-3 text-xs text-faint">
            This is unique to BSV. Most blockchains require you to trust the exchange or wait for multiple
            confirmations. Here, you get proof immediately.
          </p>
        </div>
      )}
    </div>
  );
}
