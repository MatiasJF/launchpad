import type { CSSProperties } from 'react';
import { prisma } from '@launchpad/db';
import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { Button } from '../../components/ui';
import { isAdmin } from '../../lib/auth';
import { adminLogin, adminLogout, setProjectStatus } from '../../lib/actions';

export const dynamic = 'force-dynamic';

async function PendingList() {
  const pending = await prisma.project.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });

  if (pending.length === 0) {
    return <p className="mt-6 text-muted">No projects awaiting review.</p>;
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      {pending.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface p-4"
        >
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{p.name}</h3>
              <span className="pill" style={{ '--tone': 'var(--c-warning)' } as CSSProperties}>
                pending
              </span>
            </div>
            <p className="text-sm text-muted">{p.tagline}</p>
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

export default async function AdminPage() {
  const admin = await isAdmin();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[760px] px-6 py-10">
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
          <PendingList />
        )}
      </main>
      <SiteFooter />
    </>
  );
}
