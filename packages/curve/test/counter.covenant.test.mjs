import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCovenantSpend } from '../src/covenant.ts';

// Instance locking-script hexes emitted by the sCrypt compile (see README).
// ls0/ls1/ls2 = the Counter covenant locked at count 0 / 1 / 2.
const { ls0, ls1, ls2 } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../artifacts/locks.json', import.meta.url)), 'utf8'),
);
const SATS = 1000;

// The whole point of Phase 0: a scrypt-ts-compiled stateful OP_PUSH_TX covenant
// executes correctly in @bsv/sdk's Script interpreter — our production runtime.

test('valid spend: count 0 -> 1 is accepted', () => {
  const r = validateCovenantSpend({ sourceLockHex: ls0, nextLockHex: ls1, satoshis: SATS });
  assert.equal(r.ok, true, r.error);
});

test('rejects a spend that leaves count unchanged (0 -> 0)', () => {
  const r = validateCovenantSpend({ sourceLockHex: ls0, nextLockHex: ls0, satoshis: SATS });
  assert.equal(r.ok, false);
});

test('rejects a spend that skips state (0 -> 2, must be exactly +1)', () => {
  const r = validateCovenantSpend({ sourceLockHex: ls0, nextLockHex: ls2, satoshis: SATS });
  assert.equal(r.ok, false);
});

test('the chain continues: count 1 -> 2 is accepted', () => {
  const r = validateCovenantSpend({ sourceLockHex: ls1, nextLockHex: ls2, satoshis: SATS });
  assert.equal(r.ok, true, r.error);
});
