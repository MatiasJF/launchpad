/**
 * cli.ts — stateless JSON-in/JSON-out wrapper around the LedgerPool state service.
 * Invoked as a child process by the web server (`node .../cli.js <action> <json>`),
 * so scrypt-ts never has to be bundled into the Next.js server runtime. BigInts
 * cross the boundary as decimal strings.
 */
import { computeBuySpend, computeSellDigest, computeSellUnlock, genesisPoolScript, Balance } from './ledgerState';

type Json = Record<string, unknown>;
const B = (s: unknown): bigint => BigInt(String(s));
const balances = (raw: any[]): Balance[] => (raw ?? []).map((b) => ({ ownerPkh: String(b.ownerPkh), amount: B(b.amount) }));

function main() {
  const action = process.argv[2];
  const input: Json = JSON.parse(process.argv[3] ?? '{}');
  let out: Json;

  if (action === 'genesis') {
    out = { scriptHex: genesisPoolScript(B(input.k), B(input.supply)) };
  } else if (action === 'buy') {
    const r = computeBuySpend({
      sold: B(input.sold), k: B(input.k), supply: B(input.supply), balances: balances(input.balances as any[]),
      ownerPkh: String(input.ownerPkh), delta: B(input.delta),
      poolTxid: String(input.poolTxid), poolVout: Number(input.poolVout),
      reserveBefore: Number(input.reserveBefore), newReserve: Number(input.newReserve),
    });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex };
  } else if (action === 'sell-digest') {
    const r = computeSellDigest({
      sold: B(input.sold), k: B(input.k), supply: B(input.supply), balances: balances(input.balances as any[]),
      ownerPkh: String(input.ownerPkh), amount: B(input.amount),
      poolTxid: String(input.poolTxid), poolVout: Number(input.poolVout),
      reserveBefore: Number(input.reserveBefore), payoutScriptHex: String(input.payoutScriptHex),
    });
    out = { digestHex: r.digestHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, payoutScriptHex: r.payoutScriptHex, refund: r.refund.toString(), reserveAfter: r.reserveAfter };
  } else if (action === 'sell-unlock') {
    const r = computeSellUnlock({
      sold: B(input.sold), k: B(input.k), supply: B(input.supply), balances: balances(input.balances as any[]),
      ownerPkh: String(input.ownerPkh), ownerPubHex: String(input.ownerPubHex), amount: B(input.amount),
      poolTxid: String(input.poolTxid), poolVout: Number(input.poolVout),
      reserveBefore: Number(input.reserveBefore), payoutScriptHex: String(input.payoutScriptHex),
      sigDerHex: String(input.sigDerHex),
    });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, refund: r.refund.toString() };
  } else {
    process.stderr.write(`unknown action: ${action}\n`);
    process.exit(2);
    return;
  }
  process.stdout.write(JSON.stringify(out));
}

try { main(); }
catch (e: any) { process.stderr.write('ERR: ' + (e?.message ?? String(e)) + '\n'); process.exit(1); }
