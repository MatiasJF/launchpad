import type { SaleStatus } from '@launchpad/core';

/** Placeholder card data for the explore page until DB reads land (WEB-001). */
export interface SaleCardVM {
  slug: string;
  name: string;
  ticker: string;
  blurb: string;
  status: SaleStatus;
  priceSats: number;
  soldPct: number;
  hue: number;
  countdown?: { d: number; h: number; m: number };
  holders?: number;
}

export const SEED_SALES: SaleCardVM[] = [
  {
    slug: 'orca-protocol',
    name: 'Orca Protocol',
    ticker: '$ORCA',
    blurb: 'Liquidity routing and settlement rails for BSV-native applications.',
    status: 'live',
    priceSats: 120,
    soldPct: 41,
    hue: 205,
    countdown: { d: 4, h: 5, m: 12 },
  },
  {
    slug: 'meridian',
    name: 'Meridian',
    ticker: '$MERI',
    blurb: 'On-chain identity and attestations built on BRC-100 certificates.',
    status: 'live',
    priceSats: 80,
    soldPct: 76,
    hue: 168,
    countdown: { d: 1, h: 22, m: 3 },
  },
  {
    slug: 'atlas-grid',
    name: 'Atlas Grid',
    ticker: '$ATLS',
    blurb: 'Decentralised data indexing for overlay services and SPV clients.',
    status: 'scheduled',
    priceSats: 150,
    soldPct: 0,
    hue: 38,
    countdown: { d: 2, h: 9, m: 40 },
  },
  {
    slug: 'nimbus-pay',
    name: 'Nimbus Pay',
    ticker: '$NMB',
    blurb: 'Instant micropayment tooling for merchants accepting BSV.',
    status: 'scheduled',
    priceSats: 95,
    soldPct: 0,
    hue: 275,
    countdown: { d: 6, h: 0, m: 15 },
  },
  {
    slug: 'vane',
    name: 'Vane',
    ticker: '$VANE',
    blurb: 'Timelocked treasury vaults with verifiable vesting schedules.',
    status: 'finalized',
    priceSats: 60,
    soldPct: 100,
    hue: 12,
    holders: 312,
  },
  {
    slug: 'harbor',
    name: 'Harbor',
    ticker: '$HRB',
    blurb: 'Non-custodial escrow primitives for the future presale layer.',
    status: 'finalized',
    priceSats: 110,
    soldPct: 100,
    hue: 220,
    holders: 588,
  },
];
