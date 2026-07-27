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
  blurb: string;
  status: SaleStatus;
  priceSats: number;
  soldPct: number;
  hue: number;
  countdown?: { d: number; h: number; m: number };
  about: string;
  totalSupply: number;
  publicAllocation: number;
  allocations: Allocation[];
}
