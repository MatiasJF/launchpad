/**
 * Sale logic / state machine. Stub — implemented in P3 (BSV-003 / WEB-003).
 *
 * The instant-swap path is the MVP; the escrow-presale path (soft/hard cap,
 * finalize, refund, emergency withdraw) is a future layer that reuses the same
 * hold-and-return settlement engine (ADR-008, ADR-009).
 */

import type { SaleStatus, SaleType } from '../entities';

/** Allowed status transitions per sale type. Extend as states are implemented. */
export const SALE_TRANSITIONS: Record<SaleType, Partial<Record<SaleStatus, SaleStatus[]>>> = {
  instant: {
    scheduled: ['live'],
    live: ['finalized'],
  },
  escrow_presale: {
    scheduled: ['live'],
    live: ['finalized', 'failed'],
  },
};

export function canTransition(type: SaleType, from: SaleStatus, to: SaleStatus): boolean {
  return SALE_TRANSITIONS[type][from]?.includes(to) ?? false;
}
