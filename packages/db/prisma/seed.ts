import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DAY = 86_400_000;

const STD_ALLOC = [
  { label: 'Public sale', pct: 30 },
  { label: 'Staking / rewards', pct: 25 },
  { label: 'Treasury', pct: 20 },
  { label: 'Team', pct: 15 },
  { label: 'Community', pct: 10 },
];

interface Mock {
  slug: string;
  name: string;
  ticker: string;
  blurb: string;
  about: string;
  status: 'live' | 'scheduled' | 'finalized';
  priceSats: number;
  soldPct: number;
  totalSupply: number;
  publicAllocation: number;
  endsInDays: number;
}

const MOCKS: Mock[] = [
  {
    slug: 'orca-protocol',
    name: 'Orca Protocol',
    ticker: '$ORCA',
    blurb: 'Liquidity routing and settlement rails for BSV-native applications.',
    about:
      'Orca Protocol provides a settlement and liquidity-routing layer for applications on the BSV Blockchain, sequencing on-chain STAS transfers so builders can integrate payments without running their own overlay.',
    status: 'live',
    priceSats: 120,
    soldPct: 41,
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    endsInDays: 4,
  },
  {
    slug: 'meridian',
    name: 'Meridian',
    ticker: '$MERI',
    blurb: 'On-chain identity and attestations built on BRC-100 certificates.',
    about:
      'Meridian issues verifiable identity certificates over the BRC-100 wallet interface, letting apps request attestations without custodial accounts.',
    status: 'live',
    priceSats: 80,
    soldPct: 76,
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    endsInDays: 2,
  },
  {
    slug: 'atlas-grid',
    name: 'Atlas Grid',
    ticker: '$ATLS',
    blurb: 'Decentralised data indexing for overlay services and SPV clients.',
    about:
      'Atlas Grid indexes the UTXO set into query-ready views for overlay services and light clients, so SPV apps can resolve token and application state quickly.',
    status: 'scheduled',
    priceSats: 150,
    soldPct: 0,
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    endsInDays: 9,
  },
  {
    slug: 'nimbus-pay',
    name: 'Nimbus Pay',
    ticker: '$NMB',
    blurb: 'Instant micropayment tooling for merchants accepting BSV.',
    about:
      'Nimbus Pay packages checkout, invoicing, and settlement for merchants accepting BSV, with SPV receipts the buyer can verify independently.',
    status: 'scheduled',
    priceSats: 95,
    soldPct: 0,
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    endsInDays: 12,
  },
  {
    slug: 'vane',
    name: 'Vane',
    ticker: '$VANE',
    blurb: 'Timelocked treasury vaults with verifiable vesting schedules.',
    about:
      'Vane manages project treasuries as timelocked STAS UTXOs, exposing vesting schedules on-chain so backers can verify unlock cliffs.',
    status: 'finalized',
    priceSats: 60,
    soldPct: 100,
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    endsInDays: 0,
  },
  {
    slug: 'harbor',
    name: 'Harbor',
    ticker: '$HRB',
    blurb: 'Non-custodial escrow primitives for the future presale layer.',
    about:
      'Harbor builds hold-and-return escrow primitives — the foundation for refundable presales and emergency withdraw — as auditable on-chain flows.',
    status: 'finalized',
    priceSats: 110,
    soldPct: 100,
    totalSupply: 100_000_000,
    publicAllocation: 30_000_000,
    endsInDays: 0,
  },
];

async function main() {
  await prisma.order.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.token.deleteMany();
  await prisma.event.deleteMany();
  await prisma.project.deleteMany();
  await prisma.account.deleteMany();

  await prisma.account.create({ data: { identityPubkey: 'seed-admin', role: 'admin' } });
  const issuer = await prisma.account.create({ data: { identityPubkey: 'seed-issuer', role: 'issuer' } });

  const now = Date.now();

  for (const m of MOCKS) {
    const startsAt = m.status === 'scheduled' ? new Date(now + DAY) : new Date(now - 5 * DAY);
    const endsAt = m.status === 'finalized' ? new Date(now - 3 * DAY) : new Date(now + m.endsInDays * DAY);
    const soldTokens = BigInt(Math.round((m.soldPct / 100) * m.publicAllocation));

    await prisma.project.create({
      data: {
        ownerId: issuer.id,
        slug: m.slug,
        name: m.name,
        tagline: m.blurb,
        description: m.about,
        status: 'live',
        tokens: {
          create: {
            name: m.name,
            ticker: m.ticker,
            decimals: 0,
            totalSupply: BigInt(m.totalSupply),
            allocations: JSON.stringify(STD_ALLOC),
            sales: {
              create: {
                type: 'instant',
                priceSats: BigInt(m.priceSats),
                allocationForSale: BigInt(m.publicAllocation),
                startsAt,
                endsAt,
                status: m.status,
                orders:
                  m.soldPct > 0
                    ? {
                        create: [
                          {
                            buyerIdentity: 'seed-buyer',
                            kind: 'instant_buy',
                            tokens: soldTokens,
                            satsPaid: soldTokens * BigInt(m.priceSats),
                            state: 'settled',
                          },
                        ],
                      }
                    : undefined,
              },
            },
          },
        },
      },
    });
  }

  console.log(`Seeded ${MOCKS.length} projects.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
