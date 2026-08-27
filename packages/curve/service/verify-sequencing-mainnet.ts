/**
 * verify-sequencing-mainnet.ts — PHASE 4 ACCEPTANCE TEST: permissionless sequencing (ADR-027).
 *
 * The pool is one hot UTXO, so concurrent traders collide. The claim under test is that NO
 * operator sequencer is needed to resolve that: the network picks a winner, and the loser
 * re-resolves the tip, rebuilds, RE-SIGNS and lands on its own. This runs that race for real on
 * mainnet — genuine conflicting broadcasts, genuine node rejections, genuine recovery.
 *
 *   1. RACE (buy)  — two holders build buys against the SAME tip. A lands. B is rejected by the
 *                    node (`txn-mempool-conflict`), then recovers via submitBuy and lands.
 *   2. RE-PRICED   — B's recovered buy costs MORE than its original quote, because A moved the
 *                    curve. The covenant will not honour a stale price; this asserts that.
 *   3. RACE (sell) — A builds a sell against a tip, B's buy then moves it, and A recovers. This is
 *                    the one that proves "the loser RE-SIGNS": a sell carries the holder's
 *                    signature over the spend, so the rebuilt attempt needs a brand-new signature.
 *   4. NON-RACE    — a genuinely invalid spend is NOT retried (a race loop must not mask real bugs).
 *   5. FINAL       — a fresh client rebuilds the whole pool from chain and byte-matches the tip.
 *
 * Real sats from the test CLIENT flat key (gitignored `.env`, never printed). No dry-run path:
 * a contention test that does not actually contend proves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { LedgerPoolClient, PoolTerms, FundingInput, Holder } from './ledgerClient';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const K = 1n;
const SUPPLY = 200n;
const SEED = 546;
const BUY_A = 40n; // at sold 0 → 820 sats; large enough that A can sell and still hold a balance
const BUY_B = 20n; // stale quote 210 at sold 0; re-priced to 1010 at sold 40 after losing
const BUY_B2 = 10n; // the buy that moves the tip under A's sell
// A's sell amount is DERIVED, not hardcoded: the curve refund must clear the 546-sat dust floor,
// and that threshold moves with `sold`, so a fixed number silently breaks when the constants above
// change (it did — 15 tokens refunded 495 and the client correctly refused).
function pickSellAmount(client: LedgerPoolClient, state: any, pkh: string): bigint {
  const bal = client.balanceOf(state, pkh);
  for (let n = 1n; n <= bal; n++) {
    // margin over dust so a rebuild at a different curve position still clears it
    if (client.quoteSell(state, n) >= 600n) return n;
  }
  throw new Error(`no sell amount within a balance of ${bal} clears the dust floor`);
}

// ── wallet (flat key) — NEVER printed ─────────────────────────────────────────
const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing from apps/web/.env'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const pkhA = Buffer.from(priv.toPublicKey().toHash() as number[]).toString('hex');

// Holder B is a distinct identity in the ledger. It only ever buys, so its pkh suffices.
const privB = PrivateKey.fromRandom();
const pkhB = Buffer.from(privB.toPublicKey().toHash() as number[]).toString('hex');

const TERMS: PoolTerms = { k: K, supply: SUPPLY, payoutPkh: pkhA };

/** Counts how many times the holder is asked to sign — the "loser re-signs" evidence. */
let signCount = 0;
const holderA: Holder = {
  ownerPkh: pkhA,
  ownerPubHex: priv.toPublicKey().toString(),
  async signDigest(digestHex: string) {
    signCount++;
    return B.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), B.PrivateKey.fromString(keyHex)).toDER().toString('hex');
  },
};

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};
const log = (s: string) => console.log(s);

// WhatsOnChain rate-limits hard when a run makes many requests back to back (each pool tx here is
// ~22KB, and the walk refetches them). Back off generously rather than failing the run.
async function woc(p: string, attempts = 7): Promise<Response | null> {
  let last = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${WOC}${p}`, { cache: 'no-store' });
      if (r.ok || r.status === 404) return r;
      last = r.status;
    } catch { /* retry */ }
    await sleep(2500 * (i + 1));
  }
  log(`  ⚠ WoC gave up on ${p} (last status ${last})`);
  return null;
}

const unlock = () => new P2PKH().unlock(priv, 'all', false);

async function main() {
  log(`wallet: ${address}`);
  log(`terms:  k=${K} supply=${SUPPLY} · holder A ${pkhA.slice(0, 10)}… · holder B ${pkhB.slice(0, 10)}…`);
  log('\n*** LIVE MAINNET — real contention, real rejections ***\n');

  // ── deploy the pool + all funding outputs in one tx ─────────────────────────
  log('▶ SETUP — deploy pool + funding outputs');
  const genesisScriptHex = LedgerPoolClient.genesisScript(TERMS);
  const probe = new LedgerPoolClient('0'.repeat(64), TERMS);

  // generous funding: a loser's rebuilt buy is re-priced UPWARD, so it must still be covered
  const fundA = 4600; // buy A: cost 820 + fee
  const fundB = 5200; // buy B: re-priced cost 1010 + fee
  const fundB2 = 4600; // buy B2 (moves the tip under A's sell)
  const fundSell = 4600; // sell fee input (consumed whole; sized with margin for a rebuild)
  const total = SEED + fundA + fundB + fundB2 + fundSell;

  const utxoRes = await woc(`/address/${address}/unspent`);
  if (!utxoRes || !utxoRes.ok) throw new Error('could not fetch wallet UTXOs');
  const utxos = (await utxoRes.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  const cands = utxos.filter((u) => u.value > total + 2000).sort((a, b) => b.value - a.value);
  let src: typeof cands[0] | undefined;
  for (const c of cands) {
    // WoC lists already-spent outputs as unspent — verify before building (see field notes)
    const sp = await woc(`/tx/${c.tx_hash}/${c.tx_pos}/spent`);
    if (sp && sp.status === 404) { src = c; break; }
    log(`  skipping ${c.tx_hash.slice(0, 12)}…:${c.tx_pos} — already spent`);
  }
  if (!src) throw new Error(`no verified-unspent UTXO > ${total + 2000} sats — fund ${address}`);
  const srcHexRes = await woc(`/tx/${src.tx_hash}/hex`);
  const srcHex = srcHexRes && srcHexRes.ok ? (await srcHexRes.text()).trim() : null;
  if (!srcHex) throw new Error('could not fetch parent tx');

  const deploy = new Transaction();
  deploy.addInput({ sourceTransaction: Transaction.fromHex(srcHex), sourceOutputIndex: src.tx_pos, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  deploy.addOutput({ lockingScript: Script.fromHex(genesisScriptHex), satoshis: SEED }); // 0 pool
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundA }); // 1
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundB }); // 2
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundB2 }); // 3
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundSell }); // 4
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), change: true }); // 5
  await deploy.fee();
  await deploy.sign();
  const genesisTxid = await probe.broadcast(deploy.toHex());
  log(`  ✓ pool ${genesisTxid.slice(0, 16)}…:0 @ ${SEED} sats`);
  await sleep(5000);

  const funding = (vout: number, satoshis: number): FundingInput => ({ sourceTransaction: deploy, outputIndex: vout, satoshis, unlock: unlock() });
  const pool = new LedgerPoolClient(genesisTxid, TERMS);

  // ── 1 & 2. RACE ON A BUY ────────────────────────────────────────────────────
  log('\n▶ 1. RACE (buy) — A and B both build against the SAME tip');
  const shared = await pool.state();
  log(`  shared tip: ${shared.txid.slice(0, 12)}…:${shared.vout} · sold ${shared.sold}`);
  const quotedB = pool.quoteBuy(shared, BUY_B);
  log(`  B's quote against that tip: ${quotedB} sats`);

  // both are built against `shared` — a genuine double-spend of the same pool outpoint
  const txA = await pool.buildBuy({ delta: BUY_A, ownerPkh: pkhA, funding: funding(1, fundA), state: shared });
  const txB_stale = await pool.buildBuy({ delta: BUY_B, ownerPkh: pkhB, funding: funding(2, fundB), state: shared });
  check('both racers spend the same pool outpoint', txA.spentPool.txid === txB_stale.spentPool.txid && txA.spentPool.vout === txB_stale.spentPool.vout);

  const winner = await pool.broadcast(txA.rawTx);
  log(`  ✓ A wins the race: ${winner.slice(0, 16)}…`);
  await sleep(4000);

  // the loser's pre-built tx MUST be rejected by the node — otherwise there was no race
  let rejected = '';
  try { await pool.broadcast(txB_stale.rawTx); }
  catch (e) { rejected = e instanceof Error ? e.message : String(e); }
  log(`  B's stale tx rejected: ${rejected.slice(0, 90)}`);
  check('the loser is genuinely rejected by the node', /txn-mempool-conflict|missing inputs|258/i.test(rejected), rejected || 'NOT rejected — no real race happened');

  log('\n▶ 2. RECOVER — B re-resolves, rebuilds and lands (no operator involved)');
  const recovered = await pool.submitBuy({ delta: BUY_B, ownerPkh: pkhB, funding: funding(2, fundB), state: shared });
  log(`  ✓ B recovered in ${recovered.attempts} attempt(s): ${recovered.txid.slice(0, 16)}… · cost ${recovered.cost}`);
  check('B needed more than one attempt (it really lost)', recovered.attempts >= 2, `${recovered.attempts}`);
  check('B was RE-PRICED upward by A winning', recovered.cost > quotedB, `${recovered.cost} vs stale quote ${quotedB}`);
  check('submit reports the reprice', recovered.repriced === true);
  await sleep(5000);

  // ── 3. RACE ON A SELL — the loser must RE-SIGN ──────────────────────────────
  log('\n▶ 3. RACE (sell) — A builds a sell, B moves the tip under it, A recovers');
  const beforeSell = await pool.state();
  log(`  tip ${beforeSell.txid.slice(0, 12)}…:${beforeSell.vout} · sold ${beforeSell.sold} · A holds ${pool.balanceOf(beforeSell, pkhA)}`);
  const SELL_A = pickSellAmount(pool, beforeSell, pkhA);
  log(`  derived sell amount: ${SELL_A} (refund ${pool.quoteSell(beforeSell, SELL_A)} sats, clears dust)`);
  const feeNeeded = await pool.quoteSellFee({ amount: SELL_A, holder: holderA, state: beforeSell });
  log(`  sell fee input required: ${feeNeeded} sats (funded ${fundSell}, margin covers a rebuild)`);

  // pre-size the sell fee UTXO (the covenant allows no change output on a sell)
  const feePrep = new Transaction();
  feePrep.addInput({ sourceTransaction: deploy, sourceOutputIndex: 4, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  feePrep.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: feeNeeded });
  const prepChange = fundSell - feeNeeded - 250;
  if (prepChange >= 546) feePrep.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: prepChange });
  await feePrep.sign();
  await pool.broadcast(feePrep.toHex());
  log(`  ✓ fee UTXO prepared: ${feeNeeded} sats`);
  await sleep(4000);
  const sellFunding: FundingInput = { sourceTransaction: feePrep, outputIndex: 0, satoshis: feeNeeded, unlock: unlock() };

  // B now moves the tip, invalidating A's view
  const signsBefore = signCount;
  const mover = await pool.submitBuy({ delta: BUY_B2, ownerPkh: pkhB, funding: funding(3, fundB2) });
  log(`  B moved the tip: ${mover.txid.slice(0, 16)}… (sold → ${beforeSell.sold + BUY_B2})`);
  await sleep(5000);

  // A submits against the now-stale state → must rebuild AND re-sign
  const sold = await pool.submitSell({ amount: SELL_A, holder: holderA, funding: sellFunding, state: beforeSell });
  log(`  ✓ A's sell landed in ${sold.attempts} attempt(s): ${sold.txid.slice(0, 16)}… · refund ${sold.refund}`);
  check('A had to retry (its tip was stale)', sold.attempts >= 2, `${sold.attempts}`);
  check('the loser RE-SIGNED (a fresh signature per attempt)', signCount - signsBefore === sold.attempts, `${signCount - signsBefore} signatures for ${sold.attempts} attempts`);
  await sleep(5000);

  // ── 4. a genuinely invalid spend must NOT be retried ────────────────────────
  log('\n▶ 4. NON-RACE — a real failure must not be masked by the retry loop');
  const cur = await pool.state();
  let nonRace = '';
  try {
    // funding far too small: this is invalid at every tip, not a race
    await pool.submitBuy({ delta: 5n, ownerPkh: pkhA, funding: funding(1, 5), state: cur, maxAttempts: 3 });
  } catch (e) { nonRace = e instanceof Error ? e.message : String(e); }
  check('an underfunded buy fails immediately, not after N races', /short/i.test(nonRace) && !/lost the sequencing race/i.test(nonRace), nonRace);

  // ── 5. FINAL — rebuild the whole pool from chain ────────────────────────────
  log('\n▶ 5. FINAL — a fresh client rebuilds the pool from chain');
  const fresh = new LedgerPoolClient(genesisTxid, TERMS);
  const final = await fresh.state();
  const expSold = BUY_A + BUY_B + BUY_B2 - SELL_A;
  log(`  sold ${final.sold} · reserve ${final.reserveSats} · history ${final.history.map((o) => (o.delta > 0n ? '+' : '') + o.delta).join(' ')}`);
  check('final sold accounts for every landed trade', final.sold === expSold, `${final.sold} vs ${expSold}`);
  check('A balance', fresh.balanceOf(final, pkhA) === BUY_A - SELL_A, `${fresh.balanceOf(final, pkhA)}`);
  check('B balance', fresh.balanceOf(final, pkhB) === BUY_B + BUY_B2, `${fresh.balanceOf(final, pkhB)}`);
  check('4 ops replayed (2 raced, none lost)', final.history.length === 4, `${final.history.length}`);
  check('hops == ops', final.hops === final.history.length, `${final.hops} vs ${final.history.length}`);
  const tipRes = await woc(`/tx/hash/${final.txid}`);
  const tipTx = tipRes && tipRes.ok ? ((await tipRes.json()) as any) : null;
  const onChain = (tipTx?.vout ?? []).find((o: any) => o.n === final.vout)?.scriptPubKey?.hex ?? '';
  check('reconstruction BYTE-MATCHES the on-chain tip', final.scriptHex.toLowerCase() === onChain.toLowerCase());

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  log(`re-verify: --resolve ${genesisTxid} ${SUPPLY}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
