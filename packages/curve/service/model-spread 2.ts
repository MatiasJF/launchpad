/**
 * model-spread.ts — should the ADR-030 curve carry a spread? Decide against numbers.
 *
 * Today buy and sell are exact inverses, so the pool has NO spread: precisely solvent, never
 * over-collateralised, and nothing but miner fees discourages wash trading. Adding one is a
 * covenant change and therefore a re-audit, so it is far cheaper to decide now than later.
 *
 * This models the four things that actually decide it: what a round trip already costs, what a
 * spread would add, what it would earn, and what it would cost us in provable properties.
 *
 * Offline. No network, no sats.
 */
const K = 1n;

const buyCost = (k: bigint, sold: bigint, d: bigint) => (k * d * (2n * sold + d + 1n)) / 2n;
const sellRefund = (k: bigint, sold: bigint, a: bigint) => (k * a * (2n * (sold - a) + a + 1n)) / 2n;

// Measured on mainnet: every ADR-030 pool spend is ~24.7KB, and we fee at 0.15 sat/byte.
const POOL_TX_BYTES = 24_700;
const FEE_RATE = 0.15;
const MINER_FEE = Math.ceil(POOL_TX_BYTES * FEE_RATE); // per pool spend
const ROUND_TRIP_FEE = MINER_FEE * 2; // a buy and a sell

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const sats = (n: number | bigint) => Number(n).toLocaleString('en-US');

console.log('SHOULD THE CURVE CARRY A SPREAD?\n');
console.log(`Measured inputs: pool spend ≈ ${sats(POOL_TX_BYTES)} B at ${FEE_RATE} sat/B`);
console.log(`  → miner fee ${sats(MINER_FEE)} sats per trade, ${sats(ROUND_TRIP_FEE)} sats per round trip\n`);

// ── 1. what a round trip ALREADY costs, with no spread at all ────────────────
console.log('── 1. The friction that already exists (miner fees alone) ──\n');
console.log('  trade value │ round-trip fee │  as % of trade');
console.log('  ────────────┼────────────────┼───────────────');
for (const v of [10_000, 50_000, 100_000, 500_000, 1_000_000, 10_000_000, 100_000_000]) {
  console.log(`  ${sats(v).padStart(11)} │ ${sats(ROUND_TRIP_FEE).padStart(14)} │ ${pct(ROUND_TRIP_FEE / v).padStart(14)}`);
}
console.log(`\n  A wash trader ALREADY burns ${sats(ROUND_TRIP_FEE)} sats per cycle. That is the`);
console.log('  baseline any proposed spread has to beat to be worth its cost.\n');

// ── 2. where a spread would actually bite ────────────────────────────────────
console.log('── 2. Where a spread would add more friction than miner fees already do ──\n');
console.log('  spread │ break-even trade value (above this, the spread dominates)');
console.log('  ───────┼──────────────────────────────────────────────────────────');
for (const f of [0.0025, 0.005, 0.01, 0.02, 0.05]) {
  console.log(`  ${pct(f).padStart(6)} │ ${sats(Math.ceil(ROUND_TRIP_FEE / f)).padStart(14)} sats`);
}
console.log('\n  Below its break-even a spread is noise next to the miner fee; above it, the');
console.log('  spread is what a large holder actually pays to exit.\n');

// ── 3. what a spread costs a HONEST holder, and earns the project ────────────
console.log('── 3. Cost to an honest holder vs revenue, on a realistic pool ──\n');
// a pool that raises ~0.5 BSV: k chosen so the full curve costs about that
const SUPPLY = 1000n;
const fullRaise = buyCost(K, 0n, SUPPLY);
console.log(`  Pool: k=${K}, supply=${sats(SUPPLY)} → a full sell-out raises ${sats(fullRaise)} sats\n`);
console.log('  spread │ honest holder exiting 100 tokens │ project revenue if 30% of supply exits');
console.log('  ───────┼──────────────────────────────────┼───────────────────────────────────────');
const exitAmount = 100n;
const grossRefund = sellRefund(K, SUPPLY, exitAmount);
for (const f of [0, 0.0025, 0.005, 0.01, 0.02, 0.05]) {
  const kept = Number(grossRefund) * f;
  // if 30% of the supply exits somewhere along the curve, approximate the fee on that volume
  const exitVolume = Number(buyCost(K, 0n, SUPPLY)) * 0.30;
  const revenue = exitVolume * f;
  const line = f === 0
    ? `${sats(grossRefund).padStart(12)} sats (keeps all)`
    : `${sats(Math.floor(Number(grossRefund) - kept)).padStart(12)} sats (−${sats(Math.ceil(kept))})`;
  console.log(`  ${pct(f).padStart(6)} │ ${line.padStart(32)} │ ${(f === 0 ? '0' : sats(Math.round(revenue))).padStart(30)} sats`);
}
console.log(`\n  Note the scale: even 5% on a 30%-exit is ${sats(Math.round(Number(fullRaise) * 0.30 * 0.05))} sats on this pool.`);
console.log('  Compare that to ONE mainnet pool transaction at ' + sats(MINER_FEE) + ' sats.\n');

// ── 4. what it would COST us in provable properties ──────────────────────────
console.log('── 4. What a spread costs in properties we currently have ──\n');
console.log('  Today  : refund = k·a·(2(s−a)+a+1)/2, and d·(2s+d+1) is ALWAYS even,');
console.log('           so the division is EXACT — no rounding anywhere, in anyone\'s favour.');
console.log('  With f : refund = curveRefund·(100−f)/100, which truncates.\n');

// does the truncation always favour the pool, and can splitting a sell dodge it?
let worstProportional = 0;
let anyFavoursSeller = false;
for (let f = 1; f <= 5; f++) {
  for (let r = 1; r <= 20000; r++) {
    const net = Math.floor((r * (100 - f)) / 100);
    const fee = r - net;
    if (net > r) anyFavoursSeller = true;              // must never happen
    if (fee * 100 / r < f - 0.0001 && r > 100) anyFavoursSeller = true; // under-charging
    if (r >= 10) worstProportional = Math.max(worstProportional, fee / r);
  }
}
console.log(`  Truncation direction : ${anyFavoursSeller ? 'FAVOURS THE SELLER — unsafe' : 'always favours the POOL (safe)'}`);
console.log(`  Worst effective rate on a small refund: ${pct(worstProportional)} (dust sells are taxed hardest)`);

// can a seller split to pay less total fee?
const testSold = 500n, testAmount = 100n;
for (const f of [1, 2, 5]) {
  const oneShot = Number(sellRefund(K, testSold, testAmount));
  const oneShotFee = oneShot - Math.floor((oneShot * (100 - f)) / 100);
  let split = 0, splitFee = 0, s = testSold;
  for (let i = 0n; i < testAmount; i++) {
    const r = Number(sellRefund(K, s, 1n));
    const net = Math.floor((r * (100 - f)) / 100);
    split += net; splitFee += r - net; s -= 1n;
  }
  console.log(`  f=${f}%: one sell pays ${sats(oneShotFee)} fee · ${sats(testAmount)} split sells pay ${sats(splitFee)}` +
    ` → splitting ${splitFee >= oneShotFee ? 'does NOT help' : 'DODGES the fee — unsafe'}` +
    ` (and costs ${sats(Number(testAmount) * MINER_FEE)} sats in miner fees)`);
}

console.log('\n  Also lost: `reserve == seed + k·sold·(sold+1)/2` becomes `>=`, because the pool');
console.log('  becomes over-collateralised. That is strictly SAFER, but every solvency test and');
console.log('  the audit doc\'s invariant 2 have to be restated, and the auditor must now verify a');
console.log('  rounding direction that today simply does not exist.\n');

console.log('── Bottom line ──\n');
console.log(`  • Wash trading already costs ${sats(ROUND_TRIP_FEE)} sats a cycle. A spread only`);
console.log(`    becomes the dominant deterrent above ~${sats(Math.ceil(ROUND_TRIP_FEE / 0.01))} sats per trade at 1%.`);
console.log('  • A spread is therefore about REVENUE and about protecting large holders from');
console.log('    large wash traders — not about stopping casual churn, which fees already stop.');
console.log('  • It costs: exact division, a provable equality invariant, and a new rounding');
console.log('    direction to audit. All recoverable, none free.');
console.log('  • It cannot be added later without a covenant change and a re-audit.');
