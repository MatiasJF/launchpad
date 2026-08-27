/**
 * verify-atomic-buy.ts — prove the COVENANT tolerates an ATOMIC buy layout (ADR-029).
 *
 * The atomic buy welds the reserve buy (covenant) + the STAS delivery into ONE tx:
 *   inputs : [ pool covenant, buyer payment, operator vault STAS, operator fee ]
 *   outputs: [ reserve successor, STAS -> buyer, STAS change -> vault, BSV change ]
 *
 * The pool covenant's buy() is @method(ANYONECANPAY_SINGLE) (0xc3): under BIP-143 SINGLE
 * it commits ONLY its own input and the output AT ITS OWN INDEX — every other input and
 * output is invisible to it. So the covenant must validate for ANY layout as long as the
 * reserve successor sits at the SAME index as the pool input. This proves exactly that,
 * with dummy P2PKH stand-ins for the STAS/BSV outputs (the covenant cannot tell them
 * apart from real STAS outputs — it never hashes them). The STAS engine's own output
 * conservation is validated separately (operatorDeliverStas, proven on mainnet).
 *
 * Layout A: pool at input 0 / successor at output 0 (STAS + BSV outputs trail).
 * Layout B: pool at input 2 / successor at output 2 (STAS outputs lead, at 0..1).
 * Negative: pool input 0 but successor NOT at output 0 -> MUST reject.
 */
import { StasCurvePool } from '../src/contracts/stasCurvePool';
import { PubKeyHash, toByteString, bsv } from 'scrypt-ts';
import { poolScriptForSold, encodeBuyUnlockingHex, curveCost } from '../src/curvePool';
import { validateAssembledCovenantInput } from '../src/covenant';
import artifact from '../artifacts/stasCurvePool.json';
(StasCurvePool as any).loadArtifact(artifact as any);

const B: any = bsv;
const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const opPriv = B.PrivateKey.fromRandom();
const opPub = opPriv.toPublicKey();
const opPkh = B.crypto.Hash.sha256ripemd160(opPub.toBuffer()).toString('hex');
const p2pkh = (): string => B.Script.buildPublicKeyHashOut(B.PrivateKey.fromRandom().toPublicKey().toAddress()).toHex();

function pool(sold: bigint): StasCurvePool {
  const p = new StasCurvePool(0n, K, SUPPLY, PubKeyHash(toByteString(opPkh)));
  p.sold = sold;
  return p;
}

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { if (c) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, x); } };

// Shared curve numbers: buy delta=5 from sold=0, reserve 546 -> 546+15.
const delta = 5n, reserveBefore = 546;
const cost = Number(curveCost(K, 0n, delta));
const newReserve = reserveBefore + cost;
const cur = pool(0n);
const curHex = cur.lockingScript.toHex();
const nextHex = poolScriptForSold(curHex, delta);

/** Add the pool covenant input at `poolInputIndex`, sign it over `poolOutputIndex`. */
function buildAtomic(poolInputIndex: number, poolOutputIndex: number, inputsPlan: ('pool' | 'p2pkh')[], outputsPlan: ('succ' | 'p2pkh')[]): string {
  const tx = new B.Transaction();
  inputsPlan.forEach((kind, i) => {
    const scriptHex = kind === 'pool' ? curHex : p2pkh();
    const sats = kind === 'pool' ? reserveBefore : newReserve; // arbitrary funding value for dummies
    tx.addInput(new B.Transaction.Input({ prevTxId: (i === poolInputIndex ? TXID : String.fromCharCode(98 + i).repeat(64)), outputIndex: 0, script: new B.Script() }), B.Script.fromHex(scriptHex), sats);
  });
  outputsPlan.forEach((kind) => {
    const scriptHex = kind === 'succ' ? nextHex : p2pkh();
    const sats = kind === 'succ' ? newReserve : 546;
    tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(scriptHex), satoshis: sats }));
  });
  // covenant unlock: preimage over THIS tx at 0xc3, at the pool input index (SINGLE -> output at same index).
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc3, poolInputIndex, B.Script.fromHex(curHex), new B.crypto.BN(reserveBefore));
  const unlockHex = encodeBuyUnlockingHex(delta, newReserve, Array.from(preimage) as number[]) + '00';
  tx.inputs[poolInputIndex].setScript(B.Script.fromHex(unlockHex));
  void poolOutputIndex;
  return tx.toString();
}

// ── LAYOUT A: pool at input 0 / successor at output 0; STAS+BSV outputs trail (1,2,3).
{
  const raw = buildAtomic(0, 0, ['pool', 'p2pkh', 'p2pkh', 'p2pkh'], ['succ', 'p2pkh', 'p2pkh', 'p2pkh']);
  const chk = validateAssembledCovenantInput(raw, { scriptHex: curHex, satoshis: reserveBefore }, 0);
  check('LAYOUT A: covenant validates with successor@0 + 3 trailing (STAS/BSV) outputs', chk.ok, chk.error ?? '');
}

// ── LAYOUT B: pool at input 2 / successor at output 2; STAS outputs lead (0,1), BSV trails (3).
{
  const raw = buildAtomic(2, 2, ['p2pkh', 'p2pkh', 'pool', 'p2pkh'], ['p2pkh', 'p2pkh', 'succ', 'p2pkh']);
  const chk = validateAssembledCovenantInput(raw, { scriptHex: curHex, satoshis: reserveBefore }, 2);
  check('LAYOUT B: covenant validates with successor@2 (STAS outputs lead at 0..1)', chk.ok, chk.error ?? '');
}

// ── NEGATIVE: pool at input 0 but successor NOT at output 0 -> SINGLE commits output 0,
// which is now a plain P2PKH, so the covenant hashOutputs assert must FAIL.
{
  const raw = buildAtomic(0, 0, ['pool', 'p2pkh', 'p2pkh', 'p2pkh'], ['p2pkh', 'succ', 'p2pkh', 'p2pkh']);
  const chk = validateAssembledCovenantInput(raw, { scriptHex: curHex, satoshis: reserveBefore }, 0);
  check('NEGATIVE: successor misplaced (output 1, not 0) is REJECTED', chk.ok === false, chk.error ?? '(unexpectedly validated)');
}

// ── NEGATIVE: underpay (newReserve one sat short of reserveBefore+cost) -> REJECTED even in atomic layout.
{
  const tx = new B.Transaction();
  const underNext = poolScriptForSold(curHex, delta);
  tx.addInput(new B.Transaction.Input({ prevTxId: TXID, outputIndex: 0, script: new B.Script() }), B.Script.fromHex(curHex), reserveBefore);
  tx.addInput(new B.Transaction.Input({ prevTxId: 'b'.repeat(64), outputIndex: 0, script: new B.Script() }), B.Script.fromHex(p2pkh()), newReserve);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(underNext), satoshis: newReserve - 1 })); // underpaid by 1
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(p2pkh()), satoshis: 546 }));
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc3, 0, B.Script.fromHex(curHex), new B.crypto.BN(reserveBefore));
  const unlockHex = encodeBuyUnlockingHex(delta, newReserve - 1, Array.from(preimage) as number[]) + '00';
  tx.inputs[0].setScript(B.Script.fromHex(unlockHex));
  const chk = validateAssembledCovenantInput(tx.toString(), { scriptHex: curHex, satoshis: reserveBefore }, 0);
  check('NEGATIVE: underpaid newReserve REJECTED in atomic layout', chk.ok === false, chk.error ?? '(unexpectedly validated)');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
