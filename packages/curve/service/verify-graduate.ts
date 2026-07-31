/**
 * verify-graduate.ts — GRADUATION: once sold == supply, the terminal spend releasing
 * the reserve to the committed payout validates; graduating early is rejected. No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeGraduate, type Op } from './ledgerState';

const K = 1n, SUPPLY = 10n, TXID = 'a'.repeat(64), PAYOUT = '33'.repeat(20);
const curveCost = (sold: bigint, d: bigint): bigint => (K * d * (2n * sold + d + 1n)) / 2n;

function tryGraduate(history: Op[], reserveBefore: number): { ok: boolean; error?: string } {
  let sp;
  try {
    sp = computeGraduate({ k: K, supply: SUPPLY, payoutPkh: PAYOUT, history, poolTxid: TXID, poolVout: 0, reserveBefore });
  } catch (e: any) { return { ok: false, error: 'service: ' + e.message }; }
  const outputs = [{ satoshis: reserveBefore, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) }];
  const spend = new Spend({ sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: reserveBefore, lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1, otherInputs: [], outputs, inputIndex: 0, unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0 } as any);
  try { return { ok: spend.validate() }; } catch (e: any) { return { ok: false, error: String(e.message).split('\n')[0] }; }
}

const O = '11'.repeat(20);
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { if (c) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, x); } };

// fully sold: one holder buys the whole supply (10)
const soldOut: Op[] = [{ ownerPkh: O, delta: '10' }];
const reserve = 546 + Number(curveCost(0n, 10n));
check('graduation (sold == supply) releases reserve to payout', tryGraduate(soldOut, reserve).ok);

// not fully sold: 9 of 10 — graduating must be rejected
const notDone: Op[] = [{ ownerPkh: O, delta: '9' }];
check('graduating before fully sold REJECTED', tryGraduate(notDone, 546 + Number(curveCost(0n, 9n))).ok === false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
