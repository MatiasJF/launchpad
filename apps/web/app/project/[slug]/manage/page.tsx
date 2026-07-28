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
    include: { owner: true, tokens: { include: { sales: { include: { orders: true } } } } },
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

  const vm: ManageVM = {
    projectId: project.id,
    slug: project.slug,
    name: project.name,
    status: project.status,
    payoutAddress: project.payoutAddress,
    ownerIdentity: project.owner.identityPubkey,
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
      <main className="px-6 py-10">
        <ProjectManage p={vm} />
      </main>
      <SiteFooter />
    </>
  );
}
