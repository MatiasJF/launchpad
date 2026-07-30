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
  // Bonding curve (ADR-026): opens live once the pool covenant is deployed; ends
  // 'finalized' at graduation (curve sold out / reserve threshold).
  bonding_curve: {
    scheduled: ['live'],
    live: ['finalized'],
  },
};

export function canTransition(type: SaleType, from: SaleStatus, to: SaleStatus): boolean {
  return SALE_TRANSITIONS[type][from]?.includes(to) ?? false;
}
