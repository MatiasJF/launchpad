/**
 * verify.ts — BUY: the state service's pool unlock validates in @bsv/sdk's Script
 * interpreter, using the on-chain-faithful history replay. No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeBuySpend, type Op } from './ledgerState';

const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const curveCost = (sold: bigint, delta: bigint): bigint => (K * delta * (2n * sold + delta + 1n)) / 2n;

function tryBuy(o: { history: Op[]; ownerPkh: string; delta: bigint; reserveBefore: number; newReserveOverride?: number }): { ok: boolean; error?: string } {
  const sold = o.history.reduce((s, op) => s + BigInt(op.delta), 0n);
  const newReserve = o.newReserveOverride ?? o.reserveBefore + Number(curveCost(sold, o.delta));
  let sp;
  try {
    sp = computeBuySpend({ k: K, supply: SUPPLY, history: o.history, ownerPkh: o.ownerPkh, delta: o.delta, poolTxid: TXID, poolVout: 0, reserveBefore: o.reserveBefore, newReserve });
  } catch (e: any) { return { ok: false, error: 'service: ' + e.message }; }
  const outputs = [{ satoshis: newReserve, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }];
  const spend = new Spend({ sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: o.reserveBefore, lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1, otherInputs: [], outputs, inputIndex: 0, unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0 } as any);
  try { return { ok: spend.validate() }; } catch (e: any) { return { ok: false, error: String(e.message).split('\n')[0] }; }
}

const O = '11'.repeat(20), P = '22'.repeat(20);
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { if (c) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, x); } };

check('new-holder buy (empty ledger) validates', tryBuy({ history: [], ownerPkh: O, delta: 10n, reserveBefore: 546 }).ok);
check('underpaid buy rejected', tryBuy({ history: [], ownerPkh: O, delta: 10n, reserveBefore: 546, newReserveOverride: 546 + 54 }).ok === false);
check('existing-holder buy validates', tryBuy({ history: [{ ownerPkh: O, delta: '10' }], ownerPkh: O, delta: 5n, reserveBefore: 546 + 55 }).ok);
check('second new holder into non-empty ledger validates', tryBuy({ history: [{ ownerPkh: O, delta: '15' }], ownerPkh: P, delta: 3n, reserveBefore: 700 }).ok);
check('chained: replay two buys then a third validates', tryBuy({ history: [{ ownerPkh: O, delta: '10' }, { ownerPkh: P, delta: '5' }], ownerPkh: O, delta: 4n, reserveBefore: 546 + 55 + 90 }).ok);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
