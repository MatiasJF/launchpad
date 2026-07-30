import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateBuy, curveCost } from '../src/curvePool.ts';

// Fixtures: LinearCurvePool locking-script hex per `sold`, with k=1, supply=1000.
const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL('../artifacts/curve-locks.json', import.meta.url)), 'utf8'),
);
const K = BigInt(fx.k);
const lock = (sold) => {
  const h = fx.locks[String(sold)];
  if (!h) throw new Error(`no fixture lock for sold=${sold}`);
  return h;
};

// A seed reserve the pool starts with (any dust-ish base; the curve adds on top).
const SEED = 100;

// cost(sold=0, delta=10) with k=1 = 1*10*(0+10+1)/2 = 55
test('curveCost matches the closed form', () => {
  assert.equal(curveCost(K, 0n, 10n), 55n);
  assert.equal(curveCost(K, 10n, 5n), (1n * 5n * (20n + 5n + 1n)) / 2n); // 65
});

test('buy 10 from sold=0 is accepted when newReserve covers cost exactly', () => {
  const cost = Number(curveCost(K, 0n, 10n)); // 55
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: lock(10), newReserve: SEED + cost, delta: 10n,
  });
  assert.equal(r.ok, true, r.error);
});

test('overpaying (newReserve above cost) is still accepted (rounds for the pool)', () => {
  const cost = Number(curveCost(K, 0n, 10n));
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: lock(10), newReserve: SEED + cost + 7, delta: 10n,
  });
  assert.equal(r.ok, true, r.error);
});

test('underpaying by 1 sat is REJECTED', () => {
  const cost = Number(curveCost(K, 0n, 10n));
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: lock(10), newReserve: SEED + cost - 1, delta: 10n,
  });
  assert.equal(r.ok, false);
});

test('wrong successor state (sold=15 for a delta=10 buy) is REJECTED', () => {
  const cost = Number(curveCost(K, 0n, 10n));
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: lock(15), newReserve: SEED + cost, delta: 10n, // claims 10 but re-locks to 15
  });
  assert.equal(r.ok, false);
});

test('the curve chains: buy 5 more from sold=10', () => {
  const cost = Number(curveCost(K, 10n, 5n)); // 65
  const reserveBefore = SEED + Number(curveCost(K, 0n, 10n)); // reserve after the first buy
  const r = validateBuy({
    poolLockHex: lock(10), reserveBefore,
    nextPoolLockHex: lock(15), newReserve: reserveBefore + cost, delta: 5n,
  });
  assert.equal(r.ok, true, r.error);
});

test('price rises along the curve: same delta costs more later', () => {
  assert.ok(curveCost(K, 10n, 5n) > curveCost(K, 0n, 5n));
});

test('buying the whole remaining supply at once is accepted', () => {
  const cost = Number(curveCost(K, 0n, 1000n)); // 1*1000*1001/2 = 500500
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: lock(1000), newReserve: SEED + cost, delta: 1000n,
  });
  assert.equal(r.ok, true, r.error);
});

test('overselling past supply is REJECTED', () => {
  // sold=25 fixture exists; try to buy 1000 from sold=25 -> 1025 > supply 1000.
  const r = validateBuy({
    poolLockHex: lock(25), reserveBefore: SEED,
    nextPoolLockHex: lock(1000), newReserve: SEED + 10_000_000, delta: 1000n,
  });
  assert.equal(r.ok, false);
});

test('zero-delta buy is REJECTED', () => {
  const r = validateBuy({
    poolLockHex: lock(0), reserveBefore: SEED,
    nextPoolLockHex: lock(0), newReserve: SEED, delta: 0n,
  });
  assert.equal(r.ok, false);
});
