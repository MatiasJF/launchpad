import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { Button } from '../../components/ui';
import { createProject } from '../../lib/actions';

const inputCls = 'rounded-md border border-line bg-elevated px-3 py-2.5 text-fg outline-none transition focus:border-gold';
const labelCls = 'font-mono text-xs uppercase tracking-[0.08em] text-faint';

function Field({
  name,
  label,
  type = 'text',
  required,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>
        {label}
        {required ? ' *' : ''}
      </span>
      <input name={name} type={type} required={required} min={type === 'number' ? 0 : undefined} className={inputCls} />
    </label>
  );
}

export default async function SubmitPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[680px] px-6 py-10">
        <h1 className="text-[2rem] font-semibold">Submit a project</h1>
        <p className="mt-2 text-muted">
          Create a token-sale listing. It enters review and goes live once an admin approves it.
        </p>

        {sp.ok && (
          <div className="mt-4 rounded-md border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">
            Submitted — your project is pending admin review.
          </div>
        )}
        {sp.error && (
          <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
            {sp.error === 'slug' ? 'A project with that name already exists.' : 'Please provide a name and ticker.'}
          </div>
        )}

        <form action={createProject} className="mt-6 flex flex-col gap-4">
          <Field name="name" label="Project name" required />
          <Field name="ticker" label="Ticker (e.g. $ABC)" required />
          <Field name="blurb" label="Short description" />
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>About</span>
            <textarea name="about" rows={3} className={inputCls} />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field name="totalSupply" label="Total supply" type="number" />
            <Field name="publicAllocation" label="Public allocation" type="number" />
            <Field name="priceSats" label="Price (sats)" type="number" />
          </div>
          <div className="mt-2">
            <Button variant="primary" type="submit">
              Submit for review
            </Button>
          </div>
        </form>
      </main>
      <SiteFooter />
    </>
  );
}
