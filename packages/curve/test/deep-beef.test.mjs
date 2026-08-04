import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, LockingScript, UnlockingScript, MerklePath, Beef, Utils } from '@bsv/sdk';

/**
 * Offline validation of the UNCONFIRMED-SAFE ancestry-BEEF assembly strategy used by
 * apps/web/lib/settle-actions.ts:getSourceBeefDeep. That builder walks a STAS vault's
 * ancestry, `mergeRawTx`-ing each UNCONFIRMED tx and anchoring at CONFIRMED ancestors
 * (their /beef carries a merkle BUMP), producing a valid BEEF whose TIP is unconfirmed.
 *
 * We can't hit WoC offline, so we reproduce the exact @bsv/sdk assembly the builder
 * relies on with synthetic txs: a "confirmed" root anchored by a real MerklePath BUMP,
 * spent by an "unconfirmed" tip. The invariant under test is what delivery needs:
 *   an unconfirmed tip + a bump-anchored ancestor ⇒ a structurally valid BEEF whose
 *   atomic transaction for the (unconfirmed) tip resolves — i.e. it is complete + anchored.
 */
test('deep-BEEF: unconfirmed tip anchored by a confirmed ancestor is a valid, atomic-resolvable BEEF', () => {
  // "Confirmed" root R (stands in for a mined vault ancestor).
  const R = new Transaction();
  R.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1000 }); // OP_TRUE
  const rTxid = R.id('hex');
  const rRaw = R.toHex();

  // "Unconfirmed" tip C spends R:0 (stands in for a fresh, not-yet-mined vault hop).
  const C = new Transaction();
  C.addInput({ sourceTransaction: R, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') });
  C.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 900 });
  const cTxid = C.id('hex');
  const cRaw = C.toHex();

  // A real merkle BUMP proving R (single-leaf block) — the anchor a confirmed /beef carries.
  const bump = MerklePath.fromCoinbaseTxidAndHeight(rTxid, 800000);

  // Assemble exactly as getSourceBeefDeep does: raw tip (unconfirmed) + anchored ancestor.
  const beef = new Beef();
  beef.mergeRawTx(Utils.toArray(cRaw, 'hex')); // tip: unconfirmed → raw only
  beef.mergeBump(bump); // ancestor's merkle bump (from its /beef)
  beef.mergeRawTx(Utils.toArray(rRaw, 'hex')); // ancestor raw, proven by the bump

  // Structurally valid: every tx has a bump or chains back to one (tip → R → bump).
  assert.equal(beef.isValid(), true, 'assembled BEEF must be structurally valid');

  // Round-trips through Beef.fromBinary (the same parse the operator/buyer perform).
  const bytes = beef.toBinary();
  const parsed = Beef.fromBinary(bytes);
  assert.ok(parsed, 'BEEF bytes must re-parse');

  // The UNCONFIRMED tip resolves to a complete, anchored atomic transaction — the exact
  // completeness guard getSourceBeefDeep applies before returning the bytes.
  const atomic = parsed.findAtomicTransaction(cTxid);
  assert.ok(atomic, 'atomic transaction for the unconfirmed tip must resolve (complete + anchored)');
  assert.equal(atomic.id('hex'), cTxid, 'resolved atomic tx must be the tip');
});
