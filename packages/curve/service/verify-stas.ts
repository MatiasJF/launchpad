/**
 * verify-stas.ts — StasCurvePool (ADR-028): buy validates, operator-gated sell
 * validates WITH the operator signature, and a sell without / wrong operator sig is
 * rejected. @bsv/sdk interpreter, no network.
 */
import { StasCurvePool } from '../src/contracts/stasCurvePool';
import { PubKeyHash, PubKey, Sig, toByteString, bsv } from 'scrypt-ts';
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { poolScriptForSold, encodeBuyUnlockingHex, encodeSellUnlockingHex } from '../src/curvePool';
import { validateAssembledCovenantInput } from '../src/covenant';
import { provenanceWalk } from '../src/provenance';
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

// ASSEMBLED SELL (step 3): the runtime encoder (encodeSellUnlockingHex, scrypt-ts-free)
// must byte-match the compiled sell ABI, the assembled 2-output refund tx must validate
// via @bsv/sdk, and an operator SKIM (seller refund underpaid) must be REJECTED. This is
// exactly what buildStasSellRefundTx assembles (minus the operator fee input, which the
// covenant input doesn't depend on under ANYONECANPAY|ALL).
// Build a REAL two-input/two-output sell tx with the runtime encoder (no scrypt-ts).
// `skim` underpays the seller refund by 1 sat (kept back in the reserve).
function assembleSell(signer: any, opts: { skim?: boolean } = {}) {
  const cur = pool(10n);
  const delta = 4n;
  const reserveBefore = 546 + Number(curveCost(0n, 10n));
  const newSold = 10n - delta;
  const refund = Number(curveCost(newSold, delta));
  const reserveAfter = reserveBefore - refund + (opts.skim ? 1 : 0);
  const payoutVal = refund - (opts.skim ? 1 : 0);
  const curHex = cur.lockingScript.toHex();
  const nextHex = poolScriptForSold(curHex, newSold); // byte-patch (not scrypt-ts)

  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: TXID, outputIndex: 0, script: new B.Script() }), B.Script.fromHex(curHex), reserveBefore);
  // a dummy operator fee input (irrelevant to the pool input under ANYONECANPAY)
  tx.addInput(new B.Transaction.Input({ prevTxId: 'c'.repeat(64), outputIndex: 0, script: new B.Script() }), B.Script.fromHex(payoutScriptHex), 200);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextHex), satoshis: reserveAfter }));
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: payoutVal }));

  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc1, 0, B.Script.fromHex(curHex), new B.crypto.BN(reserveBefore));
  const digest = B.crypto.Hash.sha256sha256(preimage);
  const der = B.crypto.ECDSA.sign(Buffer.from(digest), signer).toDER().toString('hex');
  const sig = der + 'c1';
  const uscHand = encodeSellUnlockingHex(delta, payoutScriptHex, opPub.toString(), sig, Array.from(preimage) as number[]) + '51';
  tx.inputs[0].setScript(B.Script.fromHex(uscHand));
  return { cur, delta, curHex, reserveBefore, sig, preimage, uscHand, rawTx: tx.toString(), nextHex, newSold, tx };
}
{
  const s = assembleSell(opPriv);
  // sanity: byte-patched successor == scrypt-ts getStateScript successor (sell direction)
  const realNextHex = String((pool(s.newSold) as any).getStateScript());
  check('poolScriptForSold matches scrypt-ts successor (sell direction)', s.nextHex === realNextHex, `patched=${s.nextHex.slice(-16)} real=${realNextHex.slice(-16)}`);
  // byte-equality of the runtime encoder against the compiled sell ABI (honest tx only —
  // getUnlockingScript runs the covenant assertions, which reject a skim/bad-sig tx).
  (s.cur as any).to = { tx: s.tx, inputIndex: 0 };
  const uscScrypt = String((s.cur as any).getUnlockingScript((sc: any) => sc.sell(s.delta, toByteString(payoutScriptHex), PubKey(toByteString(opPub.toString())), Sig(toByteString(s.sig)))).toHex());
  check('encodeSellUnlockingHex byte-matches compiled sell ABI (delta,payout,pub,sig,preimage,51)', s.uscHand === uscScrypt, `hand=${s.uscHand.slice(0, 24)}… scrypt=${uscScrypt.slice(0, 24)}…`);
  const chk = validateAssembledCovenantInput(s.rawTx, { scriptHex: s.curHex, satoshis: s.reserveBefore }, 0);
  check('assembled sell input validates (encodeSell + operator sig + 51)', chk.ok, chk.error ?? '');
}
{
  // operator SKIM: seller refund underpaid by 1 — the covenant pins hashOutputs to
  // (poolOut ++ payoutOut) at the EXACT curve refund, so this is REJECTED even with a
  // valid operator signature.
  const s = assembleSell(opPriv, { skim: true });
  const chk = validateAssembledCovenantInput(s.rawTx, { scriptHex: s.curHex, satoshis: s.reserveBefore }, 0);
  check('assembled sell REJECTED when operator skims the seller refund', chk.ok === false, chk.error ?? '');
}
{
  // wrong operator key on the ASSEMBLED tx: the operatorPkh / checkSig gate rejects.
  const s = assembleSell(B.PrivateKey.fromRandom());
  const chk = validateAssembledCovenantInput(s.rawTx, { scriptHex: s.curHex, satoshis: s.reserveBefore }, 0);
  check('assembled sell REJECTED with wrong operator key', chk.ok === false, chk.error ?? '');
}

// FIX 2 + FIX 3 tests use async (provenanceWalk) — CommonJS forbids top-level await, so
// wrap them (and the final tally) in an async IIFE. The sync tests above already ran.
void (async () => {
// ── FIX 2 (adversarial): FULL-provenance back-to-genesis. A δ-return made of
// [1 genuine ancestor + a fabricated same-tail counterfeit] must be REJECTED; a fully-
// genuine return PASSES; inflation is rejected; and the walk is bounded (fail-closed).
{
  const TAIL = 'ab'.repeat(24); // arbitrary token tail (issuer fingerprint)
  const P1 = '11'.repeat(20), P2 = '22'.repeat(20), VAULT = '33'.repeat(20);
  const st = (pkh: string) => `76a914${pkh}88ac69${TAIL}`; // same-tail STAS output
  const plain = (pkh: string) => `76a914${pkh}88ac`; // NOT STAS (no 88ac69)
  const ISS = '1'.repeat(64), DEL = '2'.repeat(64), CNT = '3'.repeat(64), MRG = '4'.repeat(64), PLN = '5'.repeat(64), INF = '6'.repeat(64);

  const outs: Record<string, { scriptHex: string; sats: number }> = {
    [`${ISS}:0`]: { scriptHex: st(VAULT), sats: 10 }, // genesis mint (10 tokens)
    [`${DEL}:0`]: { scriptHex: st(P1), sats: 6 }, // genuine delivery to a buyer
    [`${DEL}:1`]: { scriptHex: st(VAULT), sats: 4 }, // genuine change to vault
    [`${CNT}:0`]: { scriptHex: st(P2), sats: 4 }, // FABRICATED same-tail (no STAS parent)
    [`${PLN}:0`]: { scriptHex: plain(P2), sats: 4 }, // plain P2PKH funding the counterfeit
    [`${MRG}:0`]: { scriptHex: st(VAULT), sats: 10 }, // δ=10 return merging genuine+counterfeit
    [`${INF}:0`]: { scriptHex: st(P1), sats: 11 }, // inflated (11 out from a 10 genuine input)
  };
  const io: Record<string, { vin: { txid: string; vout: number }[]; vout: { n: number; hex: string; sats: number }[] }> = {
    [DEL]: { vin: [{ txid: ISS, vout: 0 }], vout: [{ n: 0, hex: st(P1), sats: 6 }, { n: 1, hex: st(VAULT), sats: 4 }] },
    [CNT]: { vin: [{ txid: PLN, vout: 0 }], vout: [{ n: 0, hex: st(P2), sats: 4 }] },
    [MRG]: { vin: [{ txid: DEL, vout: 0 }, { txid: CNT, vout: 0 }], vout: [{ n: 0, hex: st(VAULT), sats: 10 }] },
    [INF]: { vin: [{ txid: ISS, vout: 0 }], vout: [{ n: 0, hex: st(P1), sats: 11 }] },
  };
  const deps = {
    issuanceTxid: ISS,
    genuineTail: TAIL,
    getOutput: async (txid: string, vout: number) => outs[`${txid}:${vout}`] ?? null,
    getTxIO: async (txid: string) => io[txid] ?? null,
    maxNodes: 400,
  };
  const genuineDel = await provenanceWalk(DEL, 0, deps);
  check('B2G: fully-genuine return PASSES', genuineDel.authentic === true, genuineDel.reason ?? '');
  const merge = await provenanceWalk(MRG, 0, deps);
  check('B2G: [genuine + fabricated counterfeit] merge REJECTED', merge.authentic === false, `got authentic=${merge.authentic}`);
  const counterfeit = await provenanceWalk(CNT, 0, deps);
  check('B2G: fabricated same-tail (no STAS parent) REJECTED', counterfeit.authentic === false);
  const inflated = await provenanceWalk(INF, 0, deps);
  check('B2G: inflated (unbacked injected tokens) REJECTED', inflated.authentic === false);

  // Bounded / fail-closed: a genuine chain deeper than the node budget must fail closed.
  const chainOut: Record<string, { scriptHex: string; sats: number }> = { [`${ISS}:0`]: { scriptHex: st(VAULT), sats: 10 } };
  const chainIO: Record<string, { vin: { txid: string; vout: number }[]; vout: { n: number; hex: string; sats: number }[] }> = {};
  let prev = ISS;
  const hops: string[] = [];
  for (let i = 0; i < 6; i++) { const h = ('c' + i).padEnd(64, '0'); hops.push(h); chainOut[`${h}:0`] = { scriptHex: st(VAULT), sats: 10 }; chainIO[h] = { vin: [{ txid: prev, vout: 0 }], vout: [{ n: 0, hex: st(VAULT), sats: 10 }] }; prev = h; }
  const boundedDeps = { issuanceTxid: ISS, genuineTail: TAIL, getOutput: async (t: string, v: number) => chainOut[`${t}:${v}`] ?? null, getTxIO: async (t: string) => chainIO[t] ?? null, maxNodes: 2 };
  const bounded = await provenanceWalk(hops[hops.length - 1], 0, boundedDeps);
  check('B2G: chain deeper than the node budget FAILS CLOSED', bounded.authentic === false, bounded.reason ?? '');
}

// ── FIX 3 (adversarial): SELLER SIGHASH_ALL payee binding. The seller signs a 0x41 fee
// input committing output 1 (their refund). An honest tx validates both inputs; if the
// operator REDIRECTS output 1 after the seller signs (re-cosigning the covenant with a
// matching payoutScript so the covenant itself passes), the seller's 0x41 sig is
// invalidated → the fee input REJECTS the tx.
function signLocalP2pkh(tx: any, inputIndex: number, prevScriptHex: string, prevSats: number, priv: any, sighashType: number): string {
  const preimage = B.Transaction.sighash.sighashPreimage(tx, sighashType, inputIndex, B.Script.fromHex(prevScriptHex), new B.crypto.BN(prevSats));
  const digest = B.crypto.Hash.sha256sha256(preimage);
  const sig = B.crypto.ECDSA.sign(Buffer.from(digest), priv);
  const N = B.crypto.Point.getN();
  if (sig.s.gt(N.div(new B.crypto.BN(2)))) sig.s = N.sub(sig.s);
  const sigHex = sig.toDER().toString('hex') + sighashType.toString(16).padStart(2, '0');
  return B.Script.fromASM(`${sigHex} ${priv.toPublicKey().toString()}`).toHex();
}
function buildFix3(redirect: boolean) {
  const cur = pool(10n);
  const delta = 4n;
  const reserveBefore = 546 + Number(curveCost(0n, 10n));
  const newSold = 10n - delta;
  const refund = Number(curveCost(newSold, delta));
  const reserveAfter = reserveBefore - refund;
  const curHex = cur.lockingScript.toHex();
  const nextHex = poolScriptForSold(curHex, newSold);
  const sellerPriv = B.PrivateKey.fromRandom();
  const sellerScript: string = B.Script.buildPublicKeyHashOut(sellerPriv.toPublicKey().toAddress()).toHex();
  const opScript: string = B.Script.buildPublicKeyHashOut(opPub.toAddress()).toHex();
  const feeSats = 200;

  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: TXID, outputIndex: 0, script: new B.Script() }), B.Script.fromHex(curHex), reserveBefore);
  tx.addInput(new B.Transaction.Input({ prevTxId: 'e'.repeat(64), outputIndex: 0, script: new B.Script() }), B.Script.fromHex(sellerScript), feeSats);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextHex), satoshis: reserveAfter }));
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(sellerScript), satoshis: refund })); // honest: refund → seller

  // SELLER signs the fee input over ALL — committing output 1 = seller.
  const feeUnlock = signLocalP2pkh(tx, 1, sellerScript, feeSats, sellerPriv, 0x41);

  // ATTACK: operator redirects output 1 to itself AFTER the seller signed.
  let payoutScriptHexForCovenant = sellerScript;
  if (redirect) {
    tx.outputs[1] = new B.Transaction.Output({ script: B.Script.fromHex(opScript), satoshis: refund });
    payoutScriptHexForCovenant = opScript; // operator adjusts the covenant arg so ITS branch passes
  }

  // Operator co-signs the covenant input (over the CURRENT outputs).
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc1, 0, B.Script.fromHex(curHex), new B.crypto.BN(reserveBefore));
  const der = B.crypto.ECDSA.sign(Buffer.from(B.crypto.Hash.sha256sha256(preimage)), opPriv).toDER().toString('hex');
  const unlock0 = encodeSellUnlockingHex(delta, payoutScriptHexForCovenant, opPub.toString(), der + 'c1', Array.from(preimage) as number[]) + '51';
  tx.inputs[0].setScript(B.Script.fromHex(unlock0));
  tx.inputs[1].setScript(B.Script.fromHex(feeUnlock));

  const rawTx = tx.toString();
  const covenantOk = validateAssembledCovenantInput(rawTx, { scriptHex: curHex, satoshis: reserveBefore }, 0).ok;
  const feeOk = validateAssembledCovenantInput(rawTx, { scriptHex: sellerScript, satoshis: feeSats }, 1).ok;
  return { covenantOk, feeOk };
}
{
  const honest = buildFix3(false);
  check('payee: honest seller-signed TX2 validates BOTH inputs (covenant + fee)', honest.covenantOk && honest.feeOk, `covenant=${honest.covenantOk} fee=${honest.feeOk}`);
  const attack = buildFix3(true);
  // The covenant may still pass (operator adjusted its arg) but the seller's 0x41 fee sig
  // is invalidated by the redirected output — so the tx as a whole is REJECTED.
  check('payee: operator redirect of output 1 REJECTED (seller 0x41 sig invalidated)', attack.feeOk === false, `fee=${attack.feeOk} covenant=${attack.covenantOk}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
})();
