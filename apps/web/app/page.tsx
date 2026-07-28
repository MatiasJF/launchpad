import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';
import { ExploreSection } from '../components/ExploreSection';
import { StatTile } from '../components/ui';
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

      <section className="relative mx-auto max-w-[1120px] overflow-visible px-4 pb-10 pt-14 sm:px-6 sm:pt-[72px]">
        {/* decorative ambient glow */}
        <div
          aria-hidden
          className="ambient pointer-events-none absolute -right-24 -top-16 -z-10 h-[380px] w-[380px] rounded-full opacity-70 blur-3xl"
          style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--c-violet) 30%, transparent), transparent 68%)' }}
        />
        <span className="reveal font-mono text-xs uppercase tracking-[0.18em] text-gold" style={{ ['--i' as string]: 0 }}>
          On the BSV Blockchain
        </span>
        <h1 className="reveal mt-3 max-w-[16ch] text-4xl font-semibold" style={{ ['--i' as string]: 1 }}>
          Launch and back tokens,{' '}
          <span className="bg-gradient-to-r from-gold to-gold2 bg-clip-text text-transparent">settled on-chain</span>.
        </h1>
        <p className="reveal mt-4 max-w-[54ch] text-base text-muted sm:text-lg" style={{ ['--i' as string]: 2 }}>
          Projects issue STAS tokens and sell them at a fixed price. Connect your wallet and buy on mainnet — every
          purchase is a real, SPV-verifiable transaction.
        </p>
        <div className="reveal mt-7 flex flex-wrap gap-3" style={{ ['--i' as string]: 3 }}>
          <a href="#explore" className="btn btn-primary">
            Explore sales <ArrowRight />
          </a>
          <a href="#explore" className="btn btn-secondary">
            <ShieldCheck /> How settlement works
          </a>
        </div>
        <div
          className="reveal mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs text-faint"
          style={{ ['--i' as string]: 4 }}
        >
          <span className="inline-flex items-center gap-1.5 text-teal">
            <ShieldCheck width={14} height={14} /> Non-custodial
          </span>
          <span>· SPV-verifiable</span>
          <span>· Mainnet only</span>
          <span>· 1 sat = 1 token</span>
        </div>
        <div className="reveal mt-10 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:gap-4" style={{ ['--i' as string]: 5 }}>
          {[
            { label: 'Live sales', value: String(live) },
            { label: 'Raised (sats)', value: raisedFmt },
            { label: 'Listings', value: String(sales.length) },
            { label: 'Network', value: 'Mainnet' },
          ].map((st) => (
            <div key={st.label} className="glass flex-1 rounded-lg px-4 py-3 sm:min-w-[150px]">
              <StatTile label={st.label} value={st.value} />
            </div>
          ))}
        </div>
      </section>

      <ExploreSection sales={sales} />

      <SiteFooter />
    </>
  );
}
