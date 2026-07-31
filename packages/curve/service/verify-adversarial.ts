/**
 * verify-adversarial.ts — try to DRAIN the reserve. The covenant pins successor +
 * payout via hashOutputs, so tampering the broadcast outputs must be rejected.
 * History-replay reconstruction. No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeBuySpend, computeSellSpend, type Op } from './ledgerState';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const curveCost = (s: bigint, a: bigint): bigint => (K * a * (2n * s + a + 1n)) / 2n;

const priv = B.PrivateKey.fromRandom();
const pub = priv.toPublicKey();
const ownerPubHex: string = pub.toString();
const ownerPkh: string = B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');
const payoutScriptHex: string = B.Script.buildPublicKeyHashOut(pub.toAddress()).toHex();
const signHash = (d: string): string => B.crypto.ECDSA.sign(Buffer.from(d, 'hex'), priv).toDER().toString('hex');

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { if (c) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, x); } };
const validate = (sp: any, outputs: any[], reserveBefore: number) => {
  const spend = new Spend({ sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: reserveBefore, lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1, otherInputs: [], outputs, inputIndex: 0, unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0 } as any);
  try { return spend.validate(); } catch { return false; }
};

const history: Op[] = [{ ownerPkh, delta: '10' }];
const reserve = 546 + Number(curveCost(0n, 10n));
const sell = () => computeSellSpend({ k: K, supply: SUPPLY, history, ownerPkh, ownerPubHex, amount: 4n, poolTxid: TXID, poolVout: 0, reserveBefore: reserve, payoutScriptHex, signHash });

{ const sp = sell(); const r = Number(sp.refund); check('baseline honest sell validates', validate(sp, [{ satoshis: reserve - r, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }, { satoshis: r, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) }], reserve) === true); }
{ const sp = sell(); const r = Number(sp.refund); check('inflated payout REJECTED', validate(sp, [{ satoshis: reserve - r, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }, { satoshis: r + 5000, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) }], reserve) === false); }
{ const sp = sell(); const r = Number(sp.refund); check('shrunk successor reserve REJECTED', validate(sp, [{ satoshis: reserve - r - 5000, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }, { satoshis: r, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) }], reserve) === false); }
{ const sp = sell(); const r = Number(sp.refund); const atk = B.Script.buildPublicKeyHashOut(B.PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(); check('swapped successor script REJECTED', validate(sp, [{ satoshis: reserve - r, lockingScript: LockingScript.fromHex(atk) }, { satoshis: r, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) }], reserve) === false); }
{ const sp = sell(); const r = Number(sp.refund); const atk = B.Script.buildPublicKeyHashOut(B.PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(); check('redirected payout REJECTED', validate(sp, [{ satoshis: reserve - r, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }, { satoshis: r, lockingScript: LockingScript.fromHex(atk) }], reserve) === false); }
{
  const cost = Number(curveCost(0n, 3n));
  const sp = computeBuySpend({ k: K, supply: SUPPLY, history: [], ownerPkh, delta: 3n, poolTxid: TXID, poolVout: 0, reserveBefore: 546, newReserve: 546 + cost });
  const forged = computeBuySpend({ k: K, supply: SUPPLY, history: [], ownerPkh, delta: 300n, poolTxid: TXID, poolVout: 0, reserveBefore: 546, newReserve: 546 + Number(curveCost(0n, 300n)) });
  check('buy with mismatched (over-credited) successor REJECTED', validate(sp, [{ satoshis: 546 + cost, lockingScript: LockingScript.fromHex(forged.nextLockingHex) }], 546) === false);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
