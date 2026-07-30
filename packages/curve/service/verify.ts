/**
 * verify.ts — proves the ledger state service composes with @bsv/sdk: the pool-input
 * unlock built by scrypt-ts validates in @bsv/sdk's Script interpreter (our runtime
 * pre-broadcast guard). No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeBuySpend, Balance } from './ledgerState';

const K = 1n, SUPPLY = 1000n;
const curveCost = (k: bigint, sold: bigint, delta: bigint): bigint => (k * delta * (2n * sold + delta + 1n)) / 2n;
const TXID = 'a'.repeat(64);

function tryBuy(o: { sold: bigint; balances: Balance[]; ownerPkh: string; delta: bigint; reserveBefore: number; newReserveOverride?: number }): { ok: boolean; error?: string } {
  const cost = Number(curveCost(K, o.sold, o.delta));
  const newReserve = o.newReserveOverride ?? o.reserveBefore + cost;
  let sp;
  try {
    sp = computeBuySpend({ sold: o.sold, k: K, supply: SUPPLY, balances: o.balances, ownerPkh: o.ownerPkh, delta: o.delta, poolTxid: TXID, poolVout: 0, reserveBefore: o.reserveBefore, newReserve });
  } catch (e: any) { return { ok: false, error: 'service: ' + e.message }; }

  const outputs = [{ satoshis: newReserve, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }];
  const spend = new Spend({
    sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: o.reserveBefore,
    lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1,
    otherInputs: [], outputs, inputIndex: 0,
    unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0,
  } as any);
  try { return { ok: spend.validate() }; }
  catch (e: any) { return { ok: false, error: String(e.message).split('\n')[0] }; }
}

const O = '11'.repeat(20), P = '22'.repeat(20);
let pass = 0, fail = 0;
const check = (n: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, extra); } };

const r1 = tryBuy({ sold: 0n, balances: [], ownerPkh: O, delta: 10n, reserveBefore: 546 });
check('new-holder buy (empty ledger) validates', r1.ok, r1.error);

const r2 = tryBuy({ sold: 0n, balances: [], ownerPkh: O, delta: 10n, reserveBefore: 546, newReserveOverride: 546 + 54 });
check('underpaid buy rejected', r2.ok === false);

const r3 = tryBuy({ sold: 10n, balances: [{ ownerPkh: O, amount: 10n }], ownerPkh: O, delta: 5n, reserveBefore: 546 + 55 });
check('existing-holder buy validates', r3.ok, r3.error);

const r4 = tryBuy({ sold: 15n, balances: [{ ownerPkh: O, amount: 15n }], ownerPkh: P, delta: 3n, reserveBefore: 700 });
check('second new holder into non-empty ledger validates', r4.ok, r4.error);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
