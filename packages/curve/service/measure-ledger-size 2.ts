/**
 * measure-ledger-size.ts — quantify Limit A (transaction SIZE) with real numbers.
 *
 * The SMT migration is a covenant rewrite with a large audit surface, so the case for it should
 * rest on measurement rather than the assertion "HashedMap is O(holders)". This prints the actual
 * locking-script size as holders accumulate, separating fixed contract CODE from per-holder STATE,
 * and projects what that means for a real sale.
 *
 * Offline, no network, no sats.
 */
import { poolScriptForHistory, Op } from './ledgerState';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const k = 1n;
const supply = 100000n;
const payoutPkh = B.crypto.Hash.sha256ripemd160(B.PrivateKey.fromRandom().toPublicKey().toBuffer()).toString('hex');

// deterministic distinct holder pkhs
const holderPkh = (i: number) => B.crypto.Hash.sha256ripemd160(Buffer.from(`holder-${i}`)).toString('hex');

const sizeWith = (holders: number): number => {
  const history: Op[] = [];
  for (let i = 0; i < holders; i++) history.push({ ownerPkh: holderPkh(i), delta: '1' });
  return poolScriptForHistory(history, k, supply, payoutPkh).length / 2;
};

console.log('LedgerPool locking-script size vs holder count (HashedMap ledger)\n');
console.log('  holders |   script bytes |   Δ per holder');
console.log('  --------+----------------+----------------');

const points = [0, 1, 2, 5, 10, 20, 50];
let prev = 0;
const sizes: Record<number, number> = {};
for (const n of points) {
  const s = sizeWith(n);
  sizes[n] = s;
  const marginal = n === 0 ? 0 : Math.round((s - prev) / (n - points[points.indexOf(n) - 1]));
  console.log(`  ${String(n).padStart(7)} | ${String(s).padStart(14)} | ${n === 0 ? '—' : String(marginal).padStart(14)}`);
  prev = s;
}

const code = sizes[0];
const perHolder = Math.round((sizes[50] - sizes[0]) / 50);
console.log(`\nFixed contract code (0 holders): ${code} bytes`);
console.log(`Marginal cost per holder:        ~${perHolder} bytes of STATE`);

// A pool tx carries the successor script AND a sighash preimage containing the CURRENT script,
// so the on-chain cost of a single trade is roughly twice the locking script.
console.log('\nWhat that means for one TRADE (successor script + preimage ≈ 2x script):\n');
console.log('  holders |  script |   tx size |  fee @0.15 sat/B');
console.log('  --------+---------+-----------+-----------------');
for (const n of [0, 10, 50, 100, 500, 1000]) {
  const s = n <= 50 ? sizes[n] ?? code + n * perHolder : code + n * perHolder;
  const tx = 2 * s + 500;
  console.log(`  ${String(n).padStart(7)} | ${String(s).padStart(7)} | ${String(tx).padStart(9)} | ${String(Math.ceil(tx * 0.15)).padStart(16)}`);
}

console.log('\nAn SMT ledger replaces the per-holder state with a 32-byte root plus an');
console.log('O(depth) inclusion proof in the unlock — for a 32-deep tree, ~1KB, CONSTANT');
console.log('in holder count. The fixed contract code above is the floor either way.');
