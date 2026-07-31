/**
 * cli.ts — stateless JSON-in/JSON-out wrapper around the LedgerPool state service.
 * Invoked as a child process by the web server so scrypt-ts is never bundled into
 * Next.js. BigInts cross as decimal strings; the pool's op HISTORY crosses as an
 * ordered array of {ownerPkh, delta}.
 */
import { computeBuySpend, computeSellDigest, computeSellUnlock, genesisPoolScript, type Op } from './ledgerState';

type Json = Record<string, unknown>;
const B = (s: unknown): bigint => BigInt(String(s));
const history = (raw: any[]): Op[] => (raw ?? []).map((o) => ({ ownerPkh: String(o.ownerPkh), delta: String(o.delta) }));

function main() {
  const action = process.argv[2];
  const input: Json = JSON.parse(process.argv[3] ?? '{}');
  let out: Json;

  if (action === 'genesis') {
    out = { scriptHex: genesisPoolScript(B(input.k), B(input.supply)) };
  } else if (action === 'buy') {
    const r = computeBuySpend({
      k: B(input.k), supply: B(input.supply), history: history(input.history as any[]),
      ownerPkh: String(input.ownerPkh), delta: B(input.delta),
      poolTxid: String(input.poolTxid), poolVout: Number(input.poolVout),
      reserveBefore: Number(input.reserveBefore), newReserve: Number(input.newReserve),
    });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex };
  } else if (action === 'sell-digest') {
    const r = computeSellDigest({
      k: B(input.k), supply: B(input.supply), history: history(input.history as any[]),
      ownerPkh: String(input.ownerPkh), amount: B(input.amount),
      poolTxid: String(input.poolTxid), poolVout: Number(input.poolVout),
      reserveBefore: Number(input.reserveBefore), payoutScriptHex: String(input.payoutScriptHex),
    });
    out = { digestHex: r.digestHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, payoutScriptHex: r.payoutScriptHex, refund: r.refund.toString(), reserveAfter: r.reserveAfter };
  } else if (action === 'sell-unlock') {
    const r = computeSellUnlock({
      k: B(input.k), supply: B(input.supply), history: history(input.history as any[]),
      ownerPkh: String(input.ownerPkh), ownerPubHex: String(input.ownerPubHex), amount: B(input.amount),
      poolTxid: String(input.poolTxid), poolVout: Number(input.poolVout),
      reserveBefore: Number(input.reserveBefore), payoutScriptHex: String(input.payoutScriptHex), sigDerHex: String(input.sigDerHex),
    });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, refund: r.refund.toString() };
  } else {
    process.stderr.write(`unknown action: ${action}\n`);
    process.exit(2); return;
  }
  process.stdout.write(JSON.stringify(out));
}

try { main(); } catch (e: any) { process.stderr.write('ERR: ' + (e?.message ?? String(e)) + '\n'); process.exit(1); }
