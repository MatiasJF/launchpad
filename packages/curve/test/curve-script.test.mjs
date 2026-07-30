import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { poolScriptForSold, poolCodePart, validateBuy, curveCost } from '../src/curvePool.ts';

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL('../artifacts/curve-locks.json', import.meta.url)), 'utf8'),
);
const K = BigInt(fx.k);
const lock = (s) => fx.locks[String(s)];

// Every successor script we generate at runtime must byte-match the one the
// compiler produced (which is what the covenant's buildStateOutput reconstructs).
// If this ever diverges, buys would re-lock to a script the covenant rejects.
test('runtime successor script matches compiled fixtures (incl. high-bit padding)', () => {
  for (const s of [1, 10, 15, 25, 128, 200, 1000]) {
    // derive from a DIFFERENT current script to prove codePart recovery is stable
    const from = s === 10 ? lock(25) : lock(10);
    assert.equal(poolScriptForSold(from, BigInt(s)), lock(s), `sold=${s}`);
  }
});

test('codePart is identical whether derived from constructor or successor form', () => {
  // lock(0) is the deployed/constructor form (flag 0x01); lock(10) a successor (0x00)
  assert.equal(poolCodePart(lock(0)), poolCodePart(lock(10)));
  assert.equal(poolCodePart(lock(10)), poolCodePart(lock(1000)));
});

test('a buy using a runtime-derived successor validates in the interpreter', () => {
  const SEED = 546;
  const delta = 7n;
  const next = poolScriptForSold(lock(0), delta); // derived, not a fixture
  const cost = Number(curveCost(K, 0n, delta));
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: next, newReserve: SEED + cost, delta,
  });
  assert.equal(r.ok, true, r.error);
});
