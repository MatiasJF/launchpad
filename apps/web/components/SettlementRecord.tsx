import { getProjectSettlementRecord } from '../lib/merkle-ledger-actions';

/**
 * A project's record at honouring the one step the covenant cannot enforce.
 *
 * The trustless curve enforces price, custody, refunds and where the reserve goes. It cannot
 * enforce the graduation mint — converting final-ledger balances into wallet-held tokens — because
 * a STAS token input may carry only token outputs plus one change output, so real tokens cannot
 * ride the covenant spend (ADR-029). That step is a promise.
 *
 * This is the mitigation, and it is deliberately modest: the promise is PUBLIC and permanent, so
 * neglect can be shown to the next buyer before they commit. It is not a guarantee and is not
 * presented as one. A project that never mints cannot hide it; that is the whole claim.
 *
 * Server component — reads the snapshot taken at graduation, so it costs no chain walk.
 */
export async function SettlementRecord({ slug }: { slug: string }) {
  const rec = await getProjectSettlementRecord(slug);
  if (rec.outstanding.length === 0 && rec.settled.length === 0) return null;

  const owing = rec.outstanding.length > 0;

  return (
    <div className={`rounded-md border px-3 py-2.5 text-xs ${owing ? 'border-warning/40 bg-warning/10' : 'border-line bg-elevated/40'}`}>
      {owing ? (
        <>
          <p className="text-fg">
            <span className="font-semibold">This project owes holders {rec.totalOutstanding.toLocaleString()} tokens</span> from
            {rec.outstanding.length === 1 ? ' a previous sale' : ` ${rec.outstanding.length} previous sales`} that graduated but
            {rec.outstanding.length === 1 ? ' has' : ' have'} not been fully delivered
            {rec.oldestDays > 0 && <> — the oldest {rec.oldestDays === 1 ? '1 day' : `${rec.oldestDays} days`} ago</>}.
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-faint">
            {rec.outstanding.map((o) => (
              <li key={o.slug + o.ticker}>
                {o.ticker}: {o.delivered.toLocaleString()}/{o.owed.toLocaleString()} delivered · {o.daysSince}d
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted">
            Minting tokens after a curve graduates is the one step the covenant cannot enforce. The debt is recorded
            on-chain and recomputable by anyone, but nothing forces delivery — weigh this before buying.
          </p>
        </>
      ) : (
        <p className="text-muted">
          <span className="font-semibold text-fg">Settled record.</span> This project has delivered tokens to every holder of
          its {rec.settled.length === 1 ? 'graduated sale' : `${rec.settled.length} graduated sales`}
          {' '}({rec.settled.map((s) => s.ticker).join(', ')}). Post-graduation minting is the one step the covenant cannot
          enforce, so a project&apos;s history of doing it is the only signal available.
        </p>
      )}
    </div>
  );
}
