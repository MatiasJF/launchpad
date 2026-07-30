import type { CSSProperties } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSaleVMBySlug } from '../../../lib/data';
import { SiteHeader } from '../../../components/SiteHeader';
import { SiteFooter } from '../../../components/SiteFooter';
import { BuyCard } from '../../../components/BuyCard';
import { ContributeCard } from '../../../components/ContributeCard';
import { CurveBuyCard } from '../../../components/CurveBuyCard';
import { LedgerTradeCard } from '../../../components/LedgerTradeCard';
import { ClaimTokens } from '../../../components/ClaimTokens';
import { Markdown } from '../../../components/Markdown';
import { StatusPill, Tabs } from '../../../components/ui';
import { TokenomicsBar } from '../../../components/ui/TokenomicsBar';

export const dynamic = 'force-dynamic';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-elevated/40 px-3 py-2.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">{label}</span>
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
      <main className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 sm:py-10">
        <Link href="/#explore" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-fg">
          ← Back to explore
        </Link>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
          <div className="reveal">
            <div
              className="relative h-44 overflow-hidden rounded-lg border border-line sm:h-56"
              style={
                {
                  backgroundImage: s.bannerUrl
                    ? `url("${s.bannerUrl}"), linear-gradient(135deg, hsl(${s.hue} 40% 26%), hsl(${s.hue + 40} 45% 14%))`
                    : `linear-gradient(135deg, hsl(${s.hue} 40% 26%), hsl(${s.hue + 40} 45% 14%))`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                } as CSSProperties
              }
            >
              <span className="absolute bottom-4 left-5 grid h-16 w-16 place-items-center overflow-hidden rounded-2xl border border-line-strong bg-surface font-display text-2xl font-bold text-fg shadow-[var(--shadow-1)]">
                {s.logoUrl ? (
                  <img src={s.logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  s.name.charAt(0)
                )}
              </span>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <h1 className="text-[2rem] font-semibold">{s.name}</h1>
              <span className="font-mono text-sm text-faint">{s.ticker}</span>
              <StatusPill status={s.status} />
            </div>
            <p className="mt-2 max-w-[60ch] text-lg text-muted">{s.blurb}</p>
            {s.website && (
              <a
                href={s.website}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 font-mono text-xs text-teal underline underline-offset-2 hover:opacity-80"
              >
                {s.website.replace(/^https?:\/\//, '').replace(/\/$/, '')} ↗
              </a>
            )}

            <div className="mt-8 border-t border-line pt-6">
              <Tabs
                tabs={[
                  {
                    id: 'about',
                    label: 'About',
                    content: s.about ? (
                      <Markdown className="max-w-[68ch]">{s.about}</Markdown>
                    ) : (
                      <p className="text-muted">No description yet.</p>
                    ),
                  },
                  {
                    id: 'tokenomics',
                    label: 'Tokenomics',
                    content: <TokenomicsBar allocations={s.allocations} />,
                  },
                  {
                    id: 'details',
                    label: 'Details',
                    content: (
                      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
                        <Detail label="Total supply" value={s.totalSupply.toLocaleString('en-US')} />
                        <Detail label="Public allocation" value={s.publicAllocation.toLocaleString('en-US')} />
                        <Detail label="Price" value={`${s.priceSats} sats`} />
                        <Detail label="Ticker" value={s.ticker} />
                        <Detail label="Network" value="Mainnet" />
                        <Detail label="Settlement" value="On-chain · SPV" />
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          </div>

          <aside>
            {s.type === 'bonding_curve' ? (
              s.curve && s.curve.status === 'live' ? (
                s.curve.variant === 'ledger' ? <LedgerTradeCard s={s} /> : <CurveBuyCard s={s} />
              ) : (
                <div className="card p-6 text-sm text-muted">
                  This bonding-curve sale isn’t open yet — the project owner needs to deploy the pool (from their manage
                  page). Check back shortly.
                </div>
              )
            ) : s.type === 'escrow_presale' && !s.assured ? (
              <ContributeCard s={s} />
            ) : (
              <BuyCard s={s} />
            )}
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
