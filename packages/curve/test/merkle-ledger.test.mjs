/**
 * merkle-ledger.test.mjs — the bounded-size holder ledger (ADR-030).
 *
 * These are the invariants the covenant will rely on, so they are tested here first, off-chain,
 * where a failure is cheap. The load-bearing one is that `rootFromProof` — the exact computation
 * the Script will run — agrees with the tree's own root for EVERY slot, occupied or empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPTH, MAX_HOLDERS, EMPTY_LEAF, EMPTY_ROOT, EMPTY_ROOTS,
  leafHash, rootFromProof, MerkleLedger, replayMerkle,
} from '../src/merkleLedger.ts';

const pkh = (n) => n.toString(16).padStart(2, '0').repeat(20).slice(0, 40);

test('empty tree: root is the precomputed empty root, and every proof agrees', () => {
  const led = new MerkleLedger();
  assert.equal(led.holderCount, 0);
  assert.equal(led.root().toString('hex'), EMPTY_ROOT.toString('hex'));
  for (const i of [0, 1, 7, 1000, MAX_HOLDERS - 1]) {
    const p = led.proof(i);
    assert.equal(p.leaf.toString('hex'), EMPTY_LEAF.toString('hex'), `slot ${i} should be empty`);
    assert.equal(rootFromProof(i, p.leaf, p.siblings).toString('hex'), led.root().toString('hex'));
  }
});

test('proof size is constant in holder count — the whole point of ADR-030', () => {
  const led = new MerkleLedger();
  const sizeOf = (p) => p.siblings.reduce((s, b) => s + b.length, 0);
  const empty = sizeOf(led.proof(0));
  for (let i = 0; i < 200; i++) led.insert(pkh(i % 250), BigInt(i + 1));
  assert.equal(led.proof(0).siblings.length, DEPTH);
  assert.equal(sizeOf(led.proof(0)), empty, 'proof must not grow with holders');
  assert.equal(empty, DEPTH * 32);
});

test('insert appends at holderCount, and every occupied slot proves against the root', () => {
  const led = new MerkleLedger();
  for (let i = 0; i < 25; i++) {
    assert.equal(led.holderCount, i, 'append lands at holderCount');
    const idx = led.insert(pkh(i), BigInt((i + 1) * 10));
    assert.equal(idx, i);
  }
  const root = led.root().toString('hex');
  for (const e of led.entries()) {
    const p = led.proof(e.index);
    assert.equal(p.leaf.toString('hex'), leafHash(e.ownerPkh, e.balance).toString('hex'));
    assert.equal(rootFromProof(e.index, p.leaf, p.siblings).toString('hex'), root,
      `slot ${e.index} proof must reproduce the root`);
  }
});

test('the next free slot proves EMPTY — this is what authorises an append', () => {
  const led = new MerkleLedger();
  for (let i = 0; i < 9; i++) led.insert(pkh(i), 5n);
  const next = led.proof(led.holderCount);
  assert.equal(next.leaf.toString('hex'), EMPTY_LEAF.toString('hex'));
  assert.equal(rootFromProof(next.index, next.leaf, next.siblings).toString('hex'), led.root().toString('hex'));

  // and replacing that empty leaf yields exactly the root the tree reports after the insert
  const projected = rootFromProof(next.index, leafHash(pkh(99), 7n), next.siblings);
  led.insert(pkh(99), 7n);
  assert.equal(projected.toString('hex'), led.root().toString('hex'),
    'covenant-style root update must match the real tree');
});

test('update: proving the old leaf then swapping it yields the new root', () => {
  const led = new MerkleLedger();
  for (let i = 0; i < 12; i++) led.insert(pkh(i), 100n);
  const idx = 5;
  const before = led.proof(idx);
  assert.equal(rootFromProof(idx, before.leaf, before.siblings).toString('hex'), led.root().toString('hex'));

  const projected = rootFromProof(idx, leafHash(pkh(idx), 40n), before.siblings);
  led.update(idx, 40n);
  assert.equal(projected.toString('hex'), led.root().toString('hex'));
  assert.equal(led.get(idx).balance, 40n);
});

test('a changed balance changes the root (no silent no-op update)', () => {
  const led = new MerkleLedger();
  led.insert(pkh(1), 10n);
  const before = led.root().toString('hex');
  led.update(0, 11n);
  assert.notEqual(led.root().toString('hex'), before);
});

test('a proof from a stale root does NOT verify against the new root', () => {
  const led = new MerkleLedger();
  for (let i = 0; i < 6; i++) led.insert(pkh(i), 50n);
  const stale = led.proof(2);
  led.update(3, 999n); // someone else's slot moves
  assert.notEqual(rootFromProof(2, stale.leaf, stale.siblings).toString('hex'), led.root().toString('hex'),
    'a stale sibling path must not validate — this is what forces re-resolve on contention');
});

test('forged balance does not verify (the covenant cannot be lied to about a leaf)', () => {
  const led = new MerkleLedger();
  led.insert(pkh(1), 10n);
  led.insert(pkh(2), 20n);
  const p = led.proof(0);
  const forged = leafHash(pkh(1), 1_000_000n);
  assert.notEqual(rootFromProof(0, forged, p.siblings).toString('hex'), led.root().toString('hex'));
});

test('leafHash is unambiguous across (pkh, balance) pairs', () => {
  assert.notEqual(leafHash(pkh(1), 2n).toString('hex'), leafHash(pkh(2), 1n).toString('hex'));
  assert.notEqual(leafHash(pkh(1), 0n).toString('hex'), EMPTY_LEAF.toString('hex'),
    'a zero balance must be distinguishable from an empty slot');
  assert.throws(() => leafHash('abcd', 1n), /20 bytes/);
  assert.throws(() => leafHash(pkh(1), -1n), /non-negative/);
});

test('EMPTY_ROOTS ladder is internally consistent', () => {
  assert.equal(EMPTY_ROOTS.length, DEPTH + 1);
  assert.equal(EMPTY_ROOTS[0].toString('hex'), EMPTY_LEAF.toString('hex'));
  const led = new MerkleLedger();
  assert.equal(EMPTY_ROOTS[DEPTH].toString('hex'), led.root().toString('hex'));
});

test('replayMerkle reproduces balances and conserves the sold total', () => {
  const history = [
    { ownerPkh: pkh(1), delta: 40n },
    { ownerPkh: pkh(2), delta: 20n },
    { ownerPkh: pkh(1), delta: -30n },
    { ownerPkh: pkh(3), delta: 15n },
    { ownerPkh: pkh(2), delta: 5n },
  ];
  const led = replayMerkle(history);
  assert.equal(led.balanceOf(pkh(1)), 10n);
  assert.equal(led.balanceOf(pkh(2)), 25n);
  assert.equal(led.balanceOf(pkh(3)), 15n);
  const sold = history.reduce((s, o) => s + o.delta, 0n);
  assert.equal(led.total(), sold, 'sold == sum(balances) is THE reserve-safety invariant');
  assert.equal(led.holderCount, 3);
});

test('replay is deterministic: same history, same root', () => {
  const h = [
    { ownerPkh: pkh(7), delta: 3n },
    { ownerPkh: pkh(8), delta: 9n },
    { ownerPkh: pkh(7), delta: -1n },
  ];
  assert.equal(replayMerkle(h).root().toString('hex'), replayMerkle(h).root().toString('hex'));
});

test('replay rejects an impossible history', () => {
  assert.throws(() => replayMerkle([{ ownerPkh: pkh(1), delta: -5n }]), /unknown holder/);
  assert.throws(() => replayMerkle([
    { ownerPkh: pkh(1), delta: 5n },
    { ownerPkh: pkh(1), delta: -6n },
  ]), /oversold/);
});

test('duplicate holders are safe: sum is conserved and nothing is overwritten', () => {
  // the HashedMap design needed an isNew flag + non-membership proof to prevent an overwrite;
  // indexed slots make that vector structurally impossible
  const led = new MerkleLedger();
  led.insert(pkh(1), 10n);
  led.insert(pkh(1), 25n); // same holder, a second slot
  assert.equal(led.holderCount, 2);
  assert.equal(led.balanceOf(pkh(1)), 35n);
  assert.equal(led.total(), 35n);
  assert.equal(led.get(0).balance, 10n, 'the first slot is untouched');
});
