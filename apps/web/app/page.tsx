import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';
import { ExploreSection } from '../components/ExploreSection';
import { Button, StatTile } from '../components/ui';
import { ArrowRight, ShieldCheck } from '../components/ui/icons';
import { listSales } from '../lib/data';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const sales = await listSales();
  const live = sales.filter((s) => s.status === 'live').length;
  const raised = sales.reduce((sum, s) => sum + Math.round((s.soldPct / 100) * s.publicAllocation) * s.priceSats, 0);
  const raisedFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(raised);

  return (
    <>
      <SiteHeader />

      <section className="mx-auto max-w-[1120px] px-6 pb-10 pt-[72px]">
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-gold">On the BSV Blockchain</span>
        <h1 className="mt-3 max-w-[16ch] text-4xl font-semibold">
          Launch and back tokens,{' '}
          <span className="bg-gradient-to-r from-gold to-gold2 bg-clip-text text-transparent">settled on-chain</span>.
        </h1>
        <p className="mt-4 max-w-[54ch] text-lg text-muted">
          Projects issue STAS tokens and sell them at a fixed price. Connect your wallet and buy on mainnet — every
          purchase is a real, SPV-verifiable transaction.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button variant="primary">
            Explore sales <ArrowRight />
          </Button>
          <Button variant="secondary">
            <ShieldCheck /> How settlement works
          </Button>
        </div>
        <div className="mt-11 flex flex-wrap gap-10 border-t border-line pt-7">
          <StatTile label="Live sales" value={String(live)} />
          <StatTile label="Raised (sats)" value={raisedFmt} />
          <StatTile label="Listings" value={String(sales.length)} />
          <StatTile label="Network" value="Mainnet" />
        </div>
      </section>

      <ExploreSection sales={sales} />

      <SiteFooter />
    </>
  );
}
