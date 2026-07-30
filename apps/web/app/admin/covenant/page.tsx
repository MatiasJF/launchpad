import Link from 'next/link';
import { SiteHeader } from '../../../components/SiteHeader';
import { SiteFooter } from '../../../components/SiteFooter';
import { CovenantSpike } from '../../../components/CovenantSpike';
import { isAdmin } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Admin-only bench for the bonding-curve Phase 0 spike (ADR-026). Not part of the
 * public product — a place to prove the OP_PUSH_TX covenant on mainnet before we
 * build the real curve on top of it.
 */
export default async function CovenantSpikePage() {
  const admin = await isAdmin();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[720px] px-4 py-8 sm:px-6 sm:py-10">
        <Link href="/admin" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-fg">
          ← Back to admin
        </Link>
        {admin ? (
          <CovenantSpike />
        ) : (
          <p className="text-muted">Admin only. Log in on the admin page first.</p>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
