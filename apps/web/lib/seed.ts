import type { SaleStatus } from '@launchpad/core';

export interface Allocation {
  label: string;
  pct: number;
}

/** Placeholder data for the explore + sale pages until DB reads land (WEB-001). */
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
  about: string;
  totalSupply: number;
  publicAllocation: number;
  allocations: Allocation[];
}

const STD_ALLOC: Allocation[] = [
  { label: 'Public sale', pct: 30 },
  { label: 'Staking / rewards', pct: 25 },
  { label: 'Treasury', pct: 20 },
  { label: 'Team', pct: 15 },
  { label: 'Community', pct: 10 },
];

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
    about:
      'Orca Protocol provides a settlement and liquidity-routing layer for applications on the BSV Blockchain, sequencing on-chain STAS transfers so builders can integrate payments without running their own overlay. The public sale funds mainnet infrastructure and the routing operator.',
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    allocations: STD_ALLOC,
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
    about:
      'Meridian issues verifiable identity certificates over the BRC-100 wallet interface, letting apps request attestations without custodial accounts. Holders stake to run attestation nodes and earn from verification fees.',
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    allocations: STD_ALLOC,
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
    about:
      'Atlas Grid indexes the UTXO set into query-ready views for overlay services and light clients, so SPV apps can resolve token and application state quickly. The upcoming sale bootstraps the indexer network.',
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    allocations: STD_ALLOC,
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
    about:
      'Nimbus Pay packages checkout, invoicing, and settlement for merchants accepting BSV, with SPV receipts the buyer can verify independently. Token holders access reduced processing terms.',
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    allocations: STD_ALLOC,
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
    about:
      'Vane manages project treasuries as timelocked STAS UTXOs, exposing vesting schedules on-chain so backers can verify unlock cliffs. The sale finalized fully subscribed.',
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    allocations: STD_ALLOC,
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
    about:
      'Harbor builds hold-and-return escrow primitives — the foundation for refundable presales and emergency withdraw — as auditable on-chain flows. The sale finalized fully subscribed.',
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    allocations: STD_ALLOC,
  },
];

export function getSaleBySlug(slug: string): SaleCardVM | undefined {
  return SEED_SALES.find((s) => s.slug === slug);
}
