import { NextRequest, NextResponse } from 'next/server';
import { sweepPendingStasDeliveries } from '@/lib/stas-actions';
import { isAdmin } from '@/lib/auth';

/**
 * Automated delivery self-heal (delivery-robustness piece 3, ADR-028). A scheduler hits
 * this on an interval and it completes any stuck paid-but-undelivered STAS buys by
 * delegating to the idempotent `sweepPendingStasDeliveries`. This shrinks the split-buy
 * paid-but-undelivered window from "until the buyer clicks Complete delivery" to "next
 * cron tick", with no human in the loop.
 *
 * AUTH: a `CRON_SECRET` bearer token / `?secret=` (for the scheduler), OR a logged-in admin
 * session (so an operator can trigger it from the browser). Never open — the sweep spends
 * operator fees, so it must be gated. If no `CRON_SECRET` is set, only admins can call it.
 *
 * SCALE: bounded to a SMALL `limit` per call (default 5, cap 25) so each invocation finishes
 * well under the serverless timeout — deliveries are sequential (one vault UTXO) at ~seconds
 * each. Drain a large backlog by scheduling frequently (e.g. every minute), not by one big call.
 *
 * Schedule example (Vercel cron in vercel.json):
 *   { "crons": [{ "path": "/api/cron/sweep-deliveries?secret=$CRON_SECRET", "schedule": "* * * * *" }] }
 * or any external cron: `curl -s "$APP_URL/api/cron/sweep-deliveries?secret=$CRON_SECRET"`.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('secret') ??
    '';
  const authed = (!!cronSecret && provided === cronSecret) || (await isAdmin());
  if (!authed) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 25) : 5;
  const saleId = req.nextUrl.searchParams.get('saleId') ?? undefined;

  const res = await sweepPendingStasDeliveries({ saleId, limit });
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
