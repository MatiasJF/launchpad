/**
 * cli.ts — stateless JSON-in/JSON-out wrapper around the LedgerPool state service.
 * Invoked as a child process by the web server so scrypt-ts is never bundled into
 * Next.js. BigInts cross as decimal strings; the pool's op HISTORY crosses as an
 * ordered array of {ownerPkh, delta}.
 */
import { computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate, genesisPoolScript, type Op } from './ledgerState';

type Json = Record<string, unknown>;
const B = (s: unknown): bigint => BigInt(String(s));
const S = (s: unknown): string => String(s);
const history = (raw: any[]): Op[] => (raw ?? []).map((o) => ({ ownerPkh: String(o.ownerPkh), delta: String(o.delta) }));

function main() {
  const action = process.argv[2];
  const i: Json = JSON.parse(process.argv[3] ?? '{}');
  let out: Json;

  if (action === 'genesis') {
    out = { scriptHex: genesisPoolScript(B(i.k), B(i.supply), S(i.payoutPkh)) };
  } else if (action === 'buy') {
    const r = computeBuySpend({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), ownerPkh: S(i.ownerPkh), delta: B(i.delta), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), newReserve: Number(i.newReserve) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex };
  } else if (action === 'sell-digest') {
    const r = computeSellDigest({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), ownerPkh: S(i.ownerPkh), amount: B(i.amount), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), payoutScriptHex: S(i.payoutScriptHex) });
    out = { digestHex: r.digestHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, payoutScriptHex: r.payoutScriptHex, refund: r.refund.toString(), reserveAfter: r.reserveAfter };
  } else if (action === 'sell-unlock') {
    const r = computeSellUnlock({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), ownerPkh: S(i.ownerPkh), ownerPubHex: S(i.ownerPubHex), amount: B(i.amount), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), payoutScriptHex: S(i.payoutScriptHex), sigDerHex: S(i.sigDerHex) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, refund: r.refund.toString() };
  } else if (action === 'graduate') {
    const r = computeGraduate({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, payoutScriptHex: r.payoutScriptHex, reserve: r.reserve };
  } else {
    process.stderr.write(`unknown action: ${action}\n`);
    process.exit(2); return;
  }
  process.stdout.write(JSON.stringify(out));
}

try { main(); } catch (e: any) { process.stderr.write('ERR: ' + (e?.message ?? String(e)) + '\n'); process.exit(1); }
