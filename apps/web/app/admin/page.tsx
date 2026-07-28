import type { CSSProperties } from 'react';
import Link from 'next/link';
import { prisma } from '@launchpad/db';
import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { Button } from '../../components/ui';
import { isAdmin } from '../../lib/auth';
import { adminLogin, adminLogout, setProjectStatus, deleteProjectForm } from '../../lib/actions';

export const dynamic = 'force-dynamic';

/**
 * The admin's ONLY job: approve or reject listing requests. Everything a project
 * needs to do — issue its token, sell, get paid, settle — is self-service on the
 * project dashboard (/project/[slug]/manage), signed by the project's own wallet.
 * The platform never issues, settles, or holds keys.
 */
async function PendingList() {
  const pending = await prisma.project.findMany({
    where: { status: 'pending' },
    include: { owner: true },
    orderBy: { createdAt: 'desc' },
  });

  if (pending.length === 0) {
    return <p className="mt-4 text-muted">No projects awaiting review.</p>;
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      {pending.map((p, i) => (
        <div
          key={p.id}
          className="card reveal flex flex-wrap items-center justify-between gap-4 p-4"
          style={{ ['--i' as string]: i } as CSSProperties}
        >
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{p.name}</h3>
              <span className="pill" style={{ '--tone': 'var(--c-warning)' } as CSSProperties}>
                pending
              </span>
            </div>
            <p className="text-sm text-muted">{p.tagline}</p>
            <p className="mt-1 font-mono text-[0.65rem] text-faint">
              owner {p.owner.identityPubkey.slice(0, 24)}… · payout {p.payoutAddress?.slice(0, 16) ?? '—'}…
            </p>
          </div>
          <div className="flex gap-2">
            <form action={setProjectStatus}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="status" value="live" />
              <button className="btn btn-primary" type="submit">
                Approve
              </button>
            </form>
            <form action={setProjectStatus}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="status" value="closed" />
              <button className="btn btn-secondary" type="submit">
                Reject
              </button>
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}

async function AllListings() {
  const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
  if (projects.length === 0) return <p className="mt-4 text-muted">No projects.</p>;
  return (
    <div className="mt-4 flex flex-col gap-2">
      {projects.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3"
        >
          <div className="min-w-0">
            <span className="font-semibold">{p.name}</span>{' '}
            <span className="font-mono text-xs text-faint">· {p.status} · {p.slug}</span>
          </div>
          <form action={deleteProjectForm}>
            <input type="hidden" name="id" value={p.id} />
            <button className="btn border-danger/50 bg-danger/15 text-danger hover:bg-danger/25" type="submit">
              Delete
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}

export default async function AdminPage() {
  const admin = await isAdmin();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[760px] px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-[2rem] font-semibold">Admin</h1>
          {admin && (
            <form action={adminLogout}>
              <button className="btn btn-ghost" type="submit">
                Sign out
              </button>
            </form>
          )}
        </div>

        {!admin ? (
          <form action={adminLogin} className="mt-6 flex max-w-sm items-end gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Admin secret</span>
              <input
                name="secret"
                type="password"
                className="rounded-md border border-line bg-elevated px-3 py-2.5 text-fg outline-none transition focus:border-gold"
              />
            </label>
            <Button variant="primary" type="submit">
              Sign in
            </Button>
          </form>
        ) : (
          <div className="mt-8 flex flex-col gap-6">
            <section>
              <h2 className="text-xl font-semibold">Listing requests</h2>
              <p className="mt-1 text-sm text-muted">
                Approve to make the project live (its owner then issues and sells it), or reject. That is the platform&apos;s
                only role — projects manage everything else from their own dashboard.
              </p>
              <PendingList />
            </section>
            <section>
              <h2 className="text-xl font-semibold">All listings</h2>
              <p className="mt-1 text-sm text-muted">Delete any project (removes its token, sale and orders — on-chain tokens are unaffected).</p>
              <AllListings />
            </section>
            <p className="text-xs text-faint">
              Approved projects self-serve at{' '}
              <Link href="/explore" className="underline underline-offset-2 hover:text-muted">
                /explore
              </Link>{' '}
              → their sale page → “Project owner? Manage”.
            </p>
          </div>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
