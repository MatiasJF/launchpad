'use server';

import { prisma } from '@launchpad/db';

/** Portfolio holdings for a user by their identity public key. */
export async function getPortfolioHoldings(identityKey: string) {
  const orders = await prisma.order.findMany({
    where: {
      buyerIdentity: identityKey,
      state: 'settled', // Only show delivered tokens
    },
    include: {
      sale: {
        include: {
          token: {
            include: { project: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Group by token (slug) and sum tokens
  const holdings = new Map<
    string,
    {
      slug: string;
      ticker: string;
      name: string;
      logoUrl: string | null;
      tokens: number;
      latestTxid: string | null;
    }
  >();

  for (const o of orders) {
    const slug = o.sale.token.project.slug;
    const existing = holdings.get(slug);
    if (existing) {
      existing.tokens += Number(o.tokens);
      // Keep most recent delivery txid
      if (o.txid) existing.latestTxid = o.txid;
    } else {
      holdings.set(slug, {
        slug,
        ticker: o.sale.token.ticker,
        name: o.sale.token.name,
        logoUrl: o.sale.token.project.logoUrl,
        tokens: Number(o.tokens),
        latestTxid: o.txid,
      });
    }
  }

  return Array.from(holdings.values());
}

/** Portfolio order history for a user by their identity public key. */
export async function getPortfolioHistory(identityKey: string) {
  const orders = await prisma.order.findMany({
    where: { buyerIdentity: identityKey },
    include: {
      sale: {
        include: {
          token: {
            include: { project: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return orders.map((o) => ({
    orderId: o.id,
    slug: o.sale.token.project.slug,
    ticker: o.sale.token.ticker,
    name: o.sale.token.name,
    logoUrl: o.sale.token.project.logoUrl,
    tokens: Number(o.tokens),
    satsPaid: Number(o.satsPaid),
    state: o.state,
    paymentTxid: o.paymentTxid,
    deliveryTxid: o.txid,
    createdAt: o.createdAt,
  }));
}
