import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { SubmitForm } from '../../components/SubmitForm';

const ERRORS: Record<string, string> = {
  slug: 'A project with that name already exists.',
  wallet: 'Connect your wallet — a project needs an owner identity.',
  payout: 'A payout address is required.',
  missing: 'Please provide a name and ticker.',
};

export default async function SubmitPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[680px] px-6 py-10">
        <h1 className="text-[2rem] font-semibold">Submit a project</h1>
        <p className="mt-2 text-muted">
          Create a token-sale listing. It enters review and goes live once an admin approves it. You issue and settle
          your own token — the platform only approves the listing.
        </p>

        {sp.ok && (
          <div className="mt-4 rounded-md border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">
            Submitted — your project is pending admin review.
          </div>
        )}
        {sp.error && (
          <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
            {ERRORS[sp.error] ?? ERRORS.missing}
          </div>
        )}

        <SubmitForm />
      </main>
      <SiteFooter />
    </>
  );
}
