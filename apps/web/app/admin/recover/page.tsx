import Link from 'next/link';
import { SiteHeader } from '../../../components/SiteHeader';
import { SiteFooter } from '../../../components/SiteFooter';
import { RecoverStranded } from '../../../components/RecoverStranded';
import { isAdmin } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Operator bench for ADR-035 cleanup: sweep an output paid to a derived key that the
 * wallet never adopted. Not part of the product — the bug that created these is fixed,
 * this recovers the coins it already stranded.
 */
export default async function RecoverPage() {
  const admin = await isAdmin();
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[720px] px-4 py-8 sm:px-6 sm:py-10">
        <Link href="/admin" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-fg">
          ← Back to admin
        </Link>
        {admin ? <RecoverStranded /> : <p className="text-muted">Admin only. Log in on the admin page first.</p>}
      </main>
      <SiteFooter />
    </>
  );
}
