import { prisma } from '@launchpad/db';
import type { Prisma } from '@launchpad/db';
import type { SaleStatus } from '@launchpad/core';
import type { Allocation, SaleCardVM } from './types';

const saleInclude = { token: { include: { project: true } }, orders: true } satisfies Prisma.SaleInclude;
type SaleWithRels = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

function hueFromSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 360;
}

function countdownFrom(endsAt: Date | null): { d: number; h: number; m: number } | undefined {
  if (!endsAt) return undefined;
  const ms = endsAt.getTime() - Date.now();
  if (ms <= 0) return undefined;
  return {
    d: Math.floor(ms / 86_400_000),
    h: Math.floor((ms % 86_400_000) / 3_600_000),
    m: Math.floor((ms % 3_600_000) / 60_000),
  };
}

function parseWebsite(json: string | null): string | null {
  if (!json) return null;
  try {
    const w = (JSON.parse(json) as { website?: string }).website;
    return typeof w === 'string' && w ? w : null;
  } catch {
    return null;
  }
}

function parseBanner(json: string | null): string | null {
  if (!json) return null;
  try {
    const b = (JSON.parse(json) as { banner?: string }).banner;
    return typeof b === 'string' && b ? b : null;
  } catch {
    return null;
  }
}

function parseAlloc(json: string | null): Allocation[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as Allocation[];
  } catch {
    return [];
  }
}

function mapSale(s: SaleWithRels): SaleCardVM {
  const alloc = Number(s.allocationForSale);
  const soldTokens = s.orders
    .filter((o) => o.state === 'settled')
    .reduce((sum, o) => sum + Number(o.tokens), 0);
  // Committed = anything holding allocation (paid or in delivery). This is what
  // "remaining" reflects, matching the oversell guard's accounting.
  const committed = s.orders
    .filter((o) => o.state === 'pending' || o.state === 'settling' || o.state === 'settled')
    .reduce((sum, o) => sum + Number(o.tokens), 0);
  return {
    projectId: s.token.project.id,
    payoutAddress: s.token.project.payoutAddress,
    slug: s.token.project.slug,
    name: s.token.project.name,
    ticker: s.token.ticker,
    logoUrl: s.token.project.logoUrl,
    bannerUrl: parseBanner(s.token.project.media),
    website: parseWebsite(s.token.project.links),
    blurb: s.token.project.tagline ?? '',
    status: s.status as SaleStatus,
    priceSats: Number(s.priceSats),
    soldPct: alloc > 0 ? Math.round((soldTokens / alloc) * 100) : 0,
    hue: hueFromSlug(s.token.project.slug),
    countdown: countdownFrom(s.status === 'scheduled' ? s.startsAt : s.endsAt),
    about: s.token.project.description ?? '',
    totalSupply: Number(s.token.totalSupply),
    publicAllocation: alloc,
    remaining: Math.max(0, alloc - committed),
    allocations: parseAlloc(s.token.allocations),
  };
}

/** Sales for the explore page — only from projects that are approved/live. */
export async function listSales(): Promise<SaleCardVM[]> {
  const sales = await prisma.sale.findMany({
    where: { token: { project: { status: { in: ['live', 'approved'] } } } },
    include: saleInclude,
    orderBy: { createdAt: 'asc' },
  });
  return sales.map(mapSale);
}

export async function getSaleVMBySlug(slug: string): Promise<SaleCardVM | null> {
  const sale = await prisma.sale.findFirst({
    where: { token: { project: { slug } } },
    include: saleInclude,
  });
  return sale ? mapSale(sale) : null;
}
