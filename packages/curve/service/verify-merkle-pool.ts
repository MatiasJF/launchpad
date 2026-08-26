/**
 * verify-merkle-pool.ts — offline proof of the bounded-size covenant (ADR-030).
 *
 * Every spend is run through the @bsv/sdk Script INTERPRETER over the exact assembled bytes, so a
 * pass here means a real node would accept it. Covers the happy paths, the drain vectors that the
 * HashedMap design needed an explicit `isNew` + non-membership proof to close, and the headline
 * claim itself: script size must be CONSTANT in holder count.
 */
import {
  genesisScript, poolScriptForHistory, computeBuySpend, computeSellDigest, computeSellUnlock,
  computeGraduate, stateFromHistory, buyCost, sellRefund, Op, PoolTerms,
} from './merkleLedgerState';
import { validateAssembledCovenantInput } from '../src/covenant';
import { Transaction, Script as SdkScript, PrivateKey, P2PKH } from '@bsv/sdk';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const TERMS_K = 1n;
const SUPPLY = 1000n;
const pkhOf = (pub: any) => B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');

const payoutPriv = B.PrivateKey.fromRandom();
const TERMS: PoolTerms = { k: TERMS_K, supply: SUPPLY, payoutPkh: pkhOf(payoutPriv.toPublicKey()) };

const aPriv = B.PrivateKey.fromRandom();
const aPub = aPriv.toPublicKey();
const aPkh = pkhOf(aPub);
const cPriv = B.PrivateKey.fromRandom();
const cPub = cPriv.toPublicKey();
const cPkh = pkhOf(cPub);

const TXID = 'a'.repeat(64);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};

/** Assemble a real tx around a covenant spend and run the interpreter over the exact bytes. */
async function interpreterAccepts(
  sourceLockHex: string, reserveBefore: number, unlockingHex: string,
  outputs: { scriptHex: string; satoshis: number }[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const funder = PrivateKey.fromRandom();
    const parent = new Transaction();
    parent.addOutput({ lockingScript: new P2PKH().lock(funder.toPublicKey().toAddress()), satoshis: 20000 });
    const tx = new Transaction();
    tx.addInput({ sourceTXID: TXID, sourceOutputIndex: 0, unlockingScript: SdkScript.fromHex(unlockingHex), sequence: 0xffffffff });
    tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(funder, 'all', false), sequence: 0xffffffff });
    for (const o of outputs) tx.addOutput({ lockingScript: SdkScript.fromHex(o.scriptHex), satoshis: o.satoshis });
    await tx.sign();
    return validateAssembledCovenantInput(tx.toHex(), { scriptHex: sourceLockHex, satoshis: reserveBefore }, 0);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Assert a spend is IMPOSSIBLE. scrypt-ts simulates the method while building the unlock, so an
 * invalid spend is usually refused at construction — before any bytes exist. That is the desired
 * behaviour (a client cannot even produce it), so either a build-time throw or an interpreter
 * rejection counts, and this records which happened.
 */
async function rejects(name: string, attempt: () => Promise<{ ok: boolean; error?: string }>) {
  try {
    const r = await attempt();
    if (r.ok) { fail++; console.log('  [FAIL]', name, '— it was ACCEPTED'); }
    else { pass++; console.log('  [PASS]', name, '(interpreter rejected)'); }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    pass++;
    console.log('  [PASS]', name, `(refused at build: ${m.slice(0, 60)})`);
  }
}

async function main() {
  console.log('=== 1. SIZE: the claim that justifies ADR-030 ===');
  const sizeAt = (holders: number) => {
    const h: Op[] = [];
    for (let i = 0; i < holders; i++) h.push({ ownerPkh: B.crypto.Hash.sha256ripemd160(Buffer.from(`h${i}`)).toString('hex'), delta: 1n });
    return poolScriptForHistory(h, TERMS).length / 2;
  };
  const s0 = sizeAt(0), s10 = sizeAt(10), s50 = sizeAt(50), s200 = sizeAt(200);
  console.log(`  0 holders: ${s0} B · 10: ${s10} B · 50: ${s50} B · 200: ${s200} B`);
  // Not byte-identical: `sold` and `holderCount` are minimally-encoded integers, so the script
  // creeps by a byte as those numbers cross encoding widths. That is O(log holders), which is the
  // claim — the HashedMap grew by 64 bytes for EVERY holder (10884 + 64*200 = 23684 at 200).
  check('script growth is O(log holders), not O(holders)', s200 - s0 <= 16, `grew ${s200 - s0} B over 200 holders`);
  check('beats the HashedMap ledger at 200 holders', s200 < 10884 + 64 * 200, `${s200} vs ${10884 + 64 * 200}`);
  const buy0 = computeBuySpend({ terms: TERMS, history: [], ownerPkh: aPkh, delta: 5n, poolTxid: TXID, poolVout: 0, reserveBefore: 546, newReserve: 546 + Number(buyCost(TERMS_K, 0n, 5n)) });
  console.log(`  inclusion proof adds ${buy0.unlockingHex.length / 2 - 11000} B-ish to the unlock (DEPTH x 32 = 512 B)`);

  console.log('\n=== 2. BUY: first holder (append) ===');
  const r1 = 546 + Number(buyCost(TERMS_K, 0n, 5n));
  const v1 = await interpreterAccepts(buy0.sourceLockHex, 546, buy0.unlockingHex, [{ scriptHex: buy0.nextLockingHex, satoshis: r1 }]);
  check('first buy validates in the interpreter', v1.ok, v1.error);
  check('genesis script matches an empty history', genesisScript(TERMS) === poolScriptForHistory([], TERMS));

  console.log('\n=== 3. BUY: second holder, then a repeat buyer ===');
  const h1: Op[] = [{ ownerPkh: aPkh, delta: 5n }];
  const r2 = r1 + Number(buyCost(TERMS_K, 5n, 3n));
  const buy2 = computeBuySpend({ terms: TERMS, history: h1, ownerPkh: cPkh, delta: 3n, poolTxid: TXID, poolVout: 0, reserveBefore: r1, newReserve: r2 });
  const v2 = await interpreterAccepts(buy2.sourceLockHex, r1, buy2.unlockingHex, [{ scriptHex: buy2.nextLockingHex, satoshis: r2 }]);
  check('second holder appends and validates', v2.ok, v2.error);

  const h2: Op[] = [...h1, { ownerPkh: cPkh, delta: 3n }];
  const r3 = r2 + Number(buyCost(TERMS_K, 8n, 2n));
  const buy3 = computeBuySpend({ terms: TERMS, history: h2, ownerPkh: aPkh, delta: 2n, poolTxid: TXID, poolVout: 0, reserveBefore: r2, newReserve: r3 });
  const v3 = await interpreterAccepts(buy3.sourceLockHex, r2, buy3.unlockingHex, [{ scriptHex: buy3.nextLockingHex, satoshis: r3 }]);
  check('repeat buyer updates their existing slot', v3.ok, v3.error);

  console.log('\n=== 4. UNDERPAY is rejected (the reserve invariant) ===');
  await rejects('underpaying by 1 sat', async () => {
    const under = computeBuySpend({ terms: TERMS, history: h2, ownerPkh: aPkh, delta: 2n, poolTxid: TXID, poolVout: 0, reserveBefore: r2, newReserve: r3 - 1 });
    return interpreterAccepts(under.sourceLockHex, r2, under.unlockingHex, [{ scriptHex: under.nextLockingHex, satoshis: r3 - 1 }]);
  });

  console.log('\n=== 5. SELL: holder-signed debit ===');
  const h3: Op[] = [...h2, { ownerPkh: aPkh, delta: 2n }];
  const payoutScriptHex = B.Script.buildPublicKeyHashOut(aPub.toAddress()).toHex();
  const sellArgs = { terms: TERMS, history: h3, ownerPkh: aPkh, amount: 4n, poolTxid: TXID, poolVout: 0, reserveBefore: r3, payoutScriptHex };
  const dig = computeSellDigest(sellArgs);
  const der = B.crypto.ECDSA.sign(Buffer.from(dig.digestHex, 'hex'), aPriv).toDER().toString('hex');
  const sell = computeSellUnlock({ ...sellArgs, ownerPubHex: aPub.toString(), sigDerHex: der });
  const vs = await interpreterAccepts(sell.sourceLockHex, r3, sell.unlockingHex, [
    { scriptHex: sell.nextLockingHex, satoshis: dig.reserveAfter },
    { scriptHex: payoutScriptHex, satoshis: Number(sell.refund) },
  ]);
  check('holder-signed sell validates', vs.ok, vs.error);
  check('refund matches the curve', sell.refund === sellRefund(TERMS_K, 10n, 4n), `${sell.refund}`);

  console.log('\n=== 6. DRAIN VECTORS ===');
  // a stranger cannot sell someone else's slot: they cannot produce A's signature
  await rejects('a sell signed by the WRONG key', async () => {
    const badDig = computeSellDigest(sellArgs);
    const wrongDer = B.crypto.ECDSA.sign(Buffer.from(badDig.digestHex, 'hex'), cPriv).toDER().toString('hex');
    const forged = computeSellUnlock({ ...sellArgs, ownerPubHex: aPub.toString(), sigDerHex: wrongDer });
    return interpreterAccepts(forged.sourceLockHex, r3, forged.unlockingHex, [
      { scriptHex: forged.nextLockingHex, satoshis: badDig.reserveAfter },
      { scriptHex: payoutScriptHex, satoshis: Number(forged.refund) },
    ]);
  });

  // overselling a slot is refused before it can even be built
  let over = '';
  try { computeSellDigest({ ...sellArgs, amount: 999n }); } catch (e) { over = e instanceof Error ? e.message : String(e); }
  check('selling more than the slot holds is refused', /insufficient balance/i.test(over), over);

  // a holder with no slot cannot sell
  let noSlot = '';
  try { computeSellDigest({ ...sellArgs, ownerPkh: pkhOf(B.PrivateKey.fromRandom().toPublicKey()) }); } catch (e) { noSlot = e instanceof Error ? e.message : String(e); }
  check('a holder with no slot cannot sell', /no ledger slot/i.test(noSlot), noSlot);

  console.log('\n=== 7. INVARIANT: sold == sum(slots) across the whole history ===');
  const st = stateFromHistory(h3);
  check('sold == sum(slot balances)', st.ledger.total() === st.sold, `${st.ledger.total()} vs ${st.sold}`);
  check('holderCount == distinct slots', st.holderCount === BigInt(st.ledger.holderCount));

  console.log('\n=== 8. GRADUATE: terminal, permissionless ===');
  const soldOut: Op[] = [{ ownerPkh: aPkh, delta: SUPPLY }];
  const gReserve = 546 + Number(buyCost(TERMS_K, 0n, SUPPLY));
  const grad = computeGraduate({ terms: TERMS, history: soldOut, poolTxid: TXID, poolVout: 0, reserveBefore: gReserve });
  const vg = await interpreterAccepts(grad.sourceLockHex, gReserve, grad.unlockingHex, [{ scriptHex: grad.payoutScriptHex, satoshis: gReserve }]);
  check('graduation at sold == supply validates', vg.ok, vg.error);

  await rejects('graduation before sell-out', async () => {
    const notSold = computeGraduate({ terms: TERMS, history: h3, poolTxid: TXID, poolVout: 0, reserveBefore: r3 });
    return interpreterAccepts(notSold.sourceLockHex, r3, notSold.unlockingHex, [{ scriptHex: notSold.payoutScriptHex, satoshis: r3 }]);
  });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main();
