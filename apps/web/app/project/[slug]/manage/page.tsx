import { notFound } from 'next/navigation';
import { prisma } from '@launchpad/db';
import { SiteHeader } from '../../../../components/SiteHeader';
import { SiteFooter } from '../../../../components/SiteFooter';
import { ProjectManage, type ManageVM } from '../../../../components/ProjectManage';

export const dynamic = 'force-dynamic';

export default async function ManagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    include: { owner: true, tokens: { include: { sales: { include: { orders: true, pledges: true, curvePool: true } } } } },
  });
  if (!project) notFound();

  const token = project.tokens[0];
  const sale = token?.sales[0];
  const orders = (sale?.orders ?? [])
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((o) => ({
      id: o.id,
      tokens: Number(o.tokens),
      receiveAddress: o.receiveAddress,
      state: o.state,
      txid: o.txid,
      satsPaid: Number(o.satsPaid),
      buyerIdentity: o.buyerIdentity,
    }));

  let website: string | null = null;
  try {
    website = project.links ? ((JSON.parse(project.links) as { website?: string }).website ?? null) : null;
  } catch {
    website = null;
  }
  let bannerUrl: string | null = null;
  try {
    bannerUrl = project.media ? ((JSON.parse(project.media) as { banner?: string }).banner ?? null) : null;
  } catch {
    bannerUrl = null;
  }

  const vm: ManageVM = {
    projectId: project.id,
    slug: project.slug,
    name: project.name,
    status: project.status,
    payoutAddress: project.payoutAddress,
    ownerIdentity: project.owner.identityPubkey,
    description: project.description,
    logoUrl: project.logoUrl,
    bannerUrl,
    website,
    sale: sale
      ? {
          id: sale.id,
          status: sale.status,
          startsAt: sale.startsAt ? sale.startsAt.toISOString() : null,
          endsAt: sale.endsAt ? sale.endsAt.toISOString() : null,
          type: sale.type,
          softCapSats: Number(sale.softCap ?? 0n),
          hardCapSats: Number(sale.hardCap ?? 0n),
          pledgeUnitSats: Number(sale.pledgeUnitSats ?? 0n),
          raisedSats: (sale.pledges ?? [])
            .filter((p) => p.state === 'pledged' || p.state === 'assembled')
            .reduce((sum, p) => sum + Number(p.satoshis), 0),
          assured: (sale.pledges ?? []).some((p) => p.state === 'assembled'),
          curvePool: sale.curvePool
            ? {
                status: sale.curvePool.status,
                sold: Number(sale.curvePool.sold),
                supply: Number(sale.curvePool.supply),
                reserveSats: Number(sale.curvePool.reserveSats),
                poolTxid: sale.curvePool.poolTxid,
              }
            : null,
        }
      : null,
    token: token
      ? {
          ticker: token.ticker,
          supply: Number(token.totalSupply),
          issuanceTxid: token.issuanceTxid,
          tokenId: token.stasTokenId,
        }
      : null,
    orders,
  };

  return (
    <>
      <SiteHeader />
      <main className="px-4 py-8 sm:px-6 sm:py-10">
        <ProjectManage p={vm} />
      </main>
      <SiteFooter />
    </>
  );
}
