/**
 * verify-stas.ts — StasCurvePool (ADR-028): buy validates, operator-gated sell
 * validates WITH the operator signature, and a sell without / wrong operator sig is
 * rejected. @bsv/sdk interpreter, no network.
 */
import { StasCurvePool } from '../src/contracts/stasCurvePool';
import { PubKeyHash, PubKey, Sig, toByteString, bsv } from 'scrypt-ts';
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { poolScriptForSold, encodeBuyUnlockingHex } from '../src/curvePool';
import { validateAssembledCovenantInput } from '../src/covenant';
import artifact from '../artifacts/stasCurvePool.json';
(StasCurvePool as any).loadArtifact(artifact as any);

const B: any = bsv;
const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const curveCost = (sold: bigint, d: bigint): bigint => (K * d * (2n * sold + d + 1n)) / 2n;

const opPriv = B.PrivateKey.fromRandom();
const opPub = opPriv.toPublicKey();
const opPkh = B.crypto.Hash.sha256ripemd160(opPub.toBuffer()).toString('hex');
const payoutScriptHex: string = B.Script.buildPublicKeyHashOut(B.PrivateKey.fromRandom().toPublicKey().toAddress()).toHex();

function pool(sold: bigint): StasCurvePool {
  const p = new StasCurvePool(0n, K, SUPPLY, PubKeyHash(toByteString(opPkh)));
  p.sold = sold;
  return p;
}

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { if (c) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, x); } };
function run(cur: StasCurvePool, sourceLock: string, outputs: any[], reserveBefore: number, unlock: string): boolean {
  const spend = new Spend({ sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: reserveBefore, lockingScript: LockingScript.fromHex(sourceLock), transactionVersion: 1, otherInputs: [], outputs, inputIndex: 0, unlockingScript: UnlockingScript.fromHex(unlock), inputSequence: 0xffffffff, lockTime: 0 } as any);
  try { return spend.validate(); } catch { return false; }
}

// BUY: sold 0 -> 5, reserve 546 -> 546+15
{
  const cur = pool(0n); const delta = 5n; const reserveBefore = 546; const newReserve = reserveBefore + Number(curveCost(0n, delta));
  const next = pool(delta); const nextHex = String((next as any).getStateScript());
  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: TXID, outputIndex: 0, script: new B.Script() }), B.Script.fromHex(cur.lockingScript.toHex()), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextHex), satoshis: newReserve }));
  (cur as any).to = { tx, inputIndex: 0 };
  const usc = (cur as any).getUnlockingScript((s: any) => s.buy(delta, BigInt(newReserve)));
  check('buy validates (no operator needed)', run(cur, cur.lockingScript.toHex(), [{ satoshis: newReserve, lockingScript: LockingScript.fromHex(nextHex) }], reserveBefore, usc.toHex()));
}

// SELL: from sold=10, sell 4, operator co-signs
function buildSell(signer: any) {
  const cur = pool(10n); const delta = 4n; const reserveBefore = 546 + Number(curveCost(0n, 10n));
  const newSold = 10n - delta; const refund = Number(curveCost(newSold, delta)); const reserveAfter = reserveBefore - refund;
  const next = pool(newSold); const nextHex = String((next as any).getStateScript());
  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: TXID, outputIndex: 0, script: new B.Script() }), B.Script.fromHex(cur.lockingScript.toHex()), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextHex), satoshis: reserveAfter }));
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: refund }));
  (cur as any).to = { tx, inputIndex: 0 };
  // operator signs sha256sha256(preimage), sighash 0xc1
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc1, 0, B.Script.fromHex(cur.lockingScript.toHex()), new B.crypto.BN(reserveBefore));
  const digest = B.crypto.Hash.sha256sha256(preimage);
  const der = B.crypto.ECDSA.sign(Buffer.from(digest), signer).toDER().toString('hex');
  const usc = (cur as any).getUnlockingScript((s: any) => s.sell(delta, toByteString(payoutScriptHex), PubKey(toByteString(opPub.toString())), Sig(toByteString(der + 'c1'))));
  return { cur, nextHex, reserveBefore, reserveAfter, refund, usc: usc.toHex() };
}
{
  const s = buildSell(opPriv);
  const outs = [{ satoshis: s.reserveAfter, lockingScript: LockingScript.fromHex(s.nextHex) }, { satoshis: s.refund, lockingScript: LockingScript.fromHex(payoutScriptHex) }];
  check('sell validates WITH operator signature', run(s.cur, s.cur.lockingScript.toHex(), outs, s.reserveBefore, s.usc));
}
{
  let rejected = false;
  try { const s = buildSell(B.PrivateKey.fromRandom()); const outs = [{ satoshis: s.reserveAfter, lockingScript: LockingScript.fromHex(s.nextHex) }, { satoshis: s.refund, lockingScript: LockingScript.fromHex(payoutScriptHex) }]; rejected = run(s.cur, s.cur.lockingScript.toHex(), outs, s.reserveBefore, s.usc) === false; }
  catch { rejected = true; }
  check('sell REJECTED with wrong operator key', rejected);
}

// ASSEMBLED TX-A (step 2 buy): byte-patch successor (poolScriptForSold) + linear
// buy unlock + '00' selector on a REAL two-input tx, validated via @bsv/sdk. This
// is exactly what buildStasBuyTx assembles (minus the buyer payment signature,
// which the covenant input doesn't depend on under ANYONECANPAY|SINGLE).
{
  const cur = pool(0n);
  const delta = 5n;
  const reserveBefore = 546;
  const newReserve = reserveBefore + Number(curveCost(0n, delta));
  const curHex = cur.lockingScript.toHex();
  const nextHex = poolScriptForSold(curHex, delta); // byte-patch (not scrypt-ts)

  // sanity: byte-patched successor must equal the scrypt-ts getStateScript successor
  const realNextHex = String((pool(delta) as any).getStateScript());
  check('poolScriptForSold matches scrypt-ts successor (stas pool)', nextHex === realNextHex, `patched=${nextHex.slice(-16)} real=${realNextHex.slice(-16)}`);

  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: TXID, outputIndex: 0, script: new B.Script() }), B.Script.fromHex(curHex), reserveBefore);
  // a dummy buyer payment input (its signature is irrelevant to the pool input)
  tx.addInput(new B.Transaction.Input({ prevTxId: 'b'.repeat(64), outputIndex: 0, script: new B.Script() }), B.Script.fromHex(payoutScriptHex), newReserve);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextHex), satoshis: newReserve }));

  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc3, 0, B.Script.fromHex(curHex), new B.crypto.BN(reserveBefore));
  const unlockHex = encodeBuyUnlockingHex(delta, newReserve, Array.from(preimage) as number[]) + '00';
  tx.inputs[0].setScript(B.Script.fromHex(unlockHex));

  const chk = validateAssembledCovenantInput(tx.toString(), { scriptHex: curHex, satoshis: reserveBefore }, 0);
  check('assembled TX-A pool input validates (byte-patch + linear unlock + 00)', chk.ok, chk.error ?? '');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
