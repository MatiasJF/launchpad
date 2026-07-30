import type { SaleStatus } from '@launchpad/core';

export interface Allocation {
  label: string;
  pct: number;
}

/** View model for a sale card / detail page (mapped from the DB). */
export interface SaleCardVM {
  projectId: string;
  payoutAddress?: string | null;
  slug: string;
  name: string;
  ticker: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  website?: string | null;
  blurb: string;
  status: SaleStatus;
  /** Effective buyability: open only if live AND within the start/end window. */
  saleState: 'open' | 'upcoming' | 'ended';
  /** instant | escrow_presale */
  type: string;
  saleId: string;
  softCapSats: number;
  hardCapSats: number;
  pledgeUnitSats: number;
  raisedSats: number;
  /** Escrow: soft cap assembled/funded — the sale is now in the instant-buy top-up phase. */
  assured: boolean;
  priceSats: number;
  soldPct: number;
  hue: number;
  countdown?: { d: number; h: number; m: number };
  about: string;
  totalSupply: number;
  publicAllocation: number;
  /** Tokens still available to buy (allocation minus committed orders). */
  remaining: number;
  allocations: Allocation[];
}
