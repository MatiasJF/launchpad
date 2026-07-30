/**
 * verify-adversarial.ts — actively try to DRAIN the reserve. The covenant computes
 * the successor + payout and pins them via hashOutputs, so any tampering of the
 * broadcast outputs (that diverge from what the unlock's preimage committed) must be
 * rejected by the interpreter. These are the audit-gate attacks (ADR-027). No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeBuySpend, computeSellSpend } from './ledgerState';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const curveCost = (k: bigint, s: bigint, a: bigint): bigint => (k * a * (2n * s + a + 1n)) / 2n;

const priv = B.PrivateKey.fromRandom();
const pub = priv.toPublicKey();
const ownerPubHex: string = pub.toString();
const ownerPkh: string = B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');
const payoutScriptHex: string = B.Script.buildPublicKeyHashOut(pub.toAddress()).toHex();
const signHash = (digestHex: string): string => B.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), priv).toDER().toString('hex');

let pass = 0, fail = 0;
const check = (n: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, extra); } };
const validate = (sp: any, outputs: any[], reserveBefore: number) => {
  const spend = new Spend({
    sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: reserveBefore,
    lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1,
    otherInputs: [], outputs, inputIndex: 0,
    unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0,
  } as any);
  try { return spend.validate(); } catch { return false; }
};

const bal = [{ ownerPkh, amount: 10n }];
const reserve = 546 + Number(curveCost(K, 0n, 10n));
const sell = () => computeSellSpend({ sold: 10n, k: K, supply: SUPPLY, balances: bal, ownerPkh, ownerPubHex, amount: 4n, poolTxid: TXID, poolVout: 0, reserveBefore: reserve, payoutScriptHex, signHash });

// baseline: the honest sell must pass
{
  const sp = sell(); const refund = Number(sp.refund);
  const ok = validate(sp, [
    { satoshis: reserve - refund, lockingScript: LockingScript.fromHex(sp.nextLockingHex) },
    { satoshis: refund, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) },
  ], reserve);
  check('baseline honest sell validates', ok === true);
}

// ATTACK 1 — inflate the payout (seller tries to take MORE than the curve refund)
{
  const sp = sell(); const refund = Number(sp.refund);
  const drained = validate(sp, [
    { satoshis: reserve - refund, lockingScript: LockingScript.fromHex(sp.nextLockingHex) },
    { satoshis: refund + 5000, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) }, // inflated
  ], reserve);
  check('inflated payout REJECTED', drained === false);
}

// ATTACK 2 — shrink the pool's kept reserve (successor holds less than reserve-refund)
{
  const sp = sell(); const refund = Number(sp.refund);
  const drained = validate(sp, [
    { satoshis: reserve - refund - 5000, lockingScript: LockingScript.fromHex(sp.nextLockingHex) }, // pool keeps less
    { satoshis: refund, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) },
  ], reserve);
  check('shrunk successor reserve REJECTED', drained === false);
}

// ATTACK 3 — swap the successor script (e.g. redirect the pool to an attacker script)
{
  const sp = sell(); const refund = Number(sp.refund);
  const attackerScript = B.Script.buildPublicKeyHashOut(B.PrivateKey.fromRandom().toPublicKey().toAddress()).toHex();
  const drained = validate(sp, [
    { satoshis: reserve - refund, lockingScript: LockingScript.fromHex(attackerScript) }, // not the successor pool
    { satoshis: refund, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) },
  ], reserve);
  check('swapped successor script REJECTED', drained === false);
}

// ATTACK 4 — redirect the payout to an attacker address (different script)
{
  const sp = sell(); const refund = Number(sp.refund);
  const attackerPayout = B.Script.buildPublicKeyHashOut(B.PrivateKey.fromRandom().toPublicKey().toAddress()).toHex();
  const drained = validate(sp, [
    { satoshis: reserve - refund, lockingScript: LockingScript.fromHex(sp.nextLockingHex) },
    { satoshis: refund, lockingScript: LockingScript.fromHex(attackerPayout) },
  ], reserve);
  check('redirected payout REJECTED', drained === false);
}

// ATTACK 5 — pay for 3 tokens but swap in the successor that credits 300. The
// honest unlock (delta=3) commits the delta=3 successor via its preimage; feeding
// the delta=300 successor as the output must fail hashOutputs.
{
  const cost = Number(curveCost(K, 0n, 3n));
  const sp = computeBuySpend({ sold: 0n, k: K, supply: SUPPLY, balances: [], ownerPkh, delta: 3n, poolTxid: TXID, poolVout: 0, reserveBefore: 546, newReserve: 546 + cost });
  // build the delta=300 successor validly (its own correct newReserve), then steal it
  const forged = computeBuySpend({ sold: 0n, k: K, supply: SUPPLY, balances: [], ownerPkh, delta: 300n, poolTxid: TXID, poolVout: 0, reserveBefore: 546, newReserve: 546 + Number(curveCost(K, 0n, 300n)) });
  const drained = validate(sp, [
    { satoshis: 546 + cost, lockingScript: LockingScript.fromHex(forged.nextLockingHex) }, // pay for 3, credit 300
  ], 546);
  check('buy with mismatched (over-credited) successor REJECTED', drained === false);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
