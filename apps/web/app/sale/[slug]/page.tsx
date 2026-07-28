import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSaleVMBySlug } from '../../../lib/data';
import { SiteHeader } from '../../../components/SiteHeader';
import { SiteFooter } from '../../../components/SiteFooter';
import { BuyCard } from '../../../components/BuyCard';
import { ClaimTokens } from '../../../components/ClaimTokens';
import { StatusPill } from '../../../components/ui';
import { TokenomicsBar } from '../../../components/ui/TokenomicsBar';

export const dynamic = 'force-dynamic';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 border-t border-line pt-6">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">{label}</span>
      <span className="font-mono text-base font-semibold tabular-nums text-fg">{value}</span>
    </div>
  );
}

export default async function SalePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getSaleVMBySlug(slug);
  if (!s) notFound();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[1120px] px-6 py-10">
        <Link href="/#explore" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-fg">
          ← Back to explore
        </Link>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
          <div>
            <div
              className="relative h-48 overflow-hidden rounded-lg border border-line"
              style={
                {
                  '--hue': s.hue,
                  backgroundImage:
                    'linear-gradient(135deg, hsl(var(--hue) 40% 26%), hsl(calc(var(--hue) + 40) 45% 14%))',
                } as CSSProperties
              }
            >
              <span className="absolute bottom-4 left-5 grid h-16 w-16 place-items-center rounded-2xl border border-line-strong bg-surface font-display text-2xl font-bold text-fg shadow-[var(--shadow-1)]">
                {s.name.charAt(0)}
              </span>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <h1 className="text-[2rem] font-semibold">{s.name}</h1>
              <span className="font-mono text-sm text-faint">{s.ticker}</span>
              <StatusPill status={s.status} />
            </div>
            <p className="mt-2 max-w-[60ch] text-lg text-muted">{s.blurb}</p>

            <Section title="About">
              <p className="max-w-[68ch] leading-relaxed text-muted">{s.about}</p>
            </Section>

            <Section title="Tokenomics">
              <TokenomicsBar allocations={s.allocations} />
            </Section>

            <Section title="Details">
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
                <Detail label="Total supply" value={s.totalSupply.toLocaleString('en-US')} />
                <Detail label="Public allocation" value={s.publicAllocation.toLocaleString('en-US')} />
                <Detail label="Price" value={`${s.priceSats} sats`} />
                <Detail label="Ticker" value={s.ticker} />
                <Detail label="Network" value="Mainnet" />
                <Detail label="Settlement" value="On-chain · SPV" />
              </div>
            </Section>
          </div>

          <aside>
            <BuyCard s={s} />
            <ClaimTokens slug={s.slug} />
            <Link
              href={`/project/${s.slug}/manage`}
              className="mt-4 block text-center font-mono text-xs text-faint underline underline-offset-2 hover:text-muted"
            >
              Project owner? Manage →
            </Link>
          </aside>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
