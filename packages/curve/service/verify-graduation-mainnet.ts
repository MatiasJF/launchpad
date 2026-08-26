/**
 * verify-graduation-mainnet.ts — PHASE 5a: PERMISSIONLESS GRADUATION, end to end on mainnet.
 *
 * Graduation is the last covenant path that had never been driven on a live pool. It is the
 * terminal step: once `sold == supply`, the whole reserve is released to a payout address baked
 * into the covenant at DEPLOY, with no signature of any kind. The properties that matters are:
 *
 *   - ANYONE can trigger it. The test graduates using a STRANGER key — freshly generated, holding
 *     no tokens, no operator role, no relationship to the pool — to show no permission exists.
 *   - The stranger CANNOT STEER THE MONEY. The destination was fixed at deploy, so a hostile
 *     graduator can only pay the project. The test asserts the released sats land on the committed
 *     payout script and that the stranger's own address receives only its change.
 *   - The final ledger survives. Holder balances stay reconstructible from chain after the pool
 *     UTXO is gone — that list is what real STAS is minted against, so losing it would strand
 *     every contributor.
 *
 * Flow: deploy → buy → buy to EXACTLY sold == supply → refuse to graduate early → stranger
 * graduates → verify the payout on chain → re-resolve and confirm the terminal state.
 *
 * Real sats from the test CLIENT flat key (gitignored `.env`, never printed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { LedgerPoolClient, PoolTerms, FundingInput } from './ledgerClient';
import { resolveLedgerPool } from './resolveLedgerPool';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const K = 1n;
const SUPPLY = 24n; // small: the curve must be bought out ENTIRELY for graduation to unlock
const SEED = 546;
const BUY_A = 14n; // cost 105  → reserve 651
const BUY_B = 10n; // cost 195  → reserve 846, and sold == supply exactly

// ── wallet (flat key) — NEVER printed ─────────────────────────────────────────
const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing from apps/web/.env'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const pkhA = Buffer.from(priv.toPublicKey().toHash() as number[]).toString('hex');

const privB = PrivateKey.fromRandom();
const pkhB = Buffer.from(privB.toPublicKey().toHash() as number[]).toString('hex');

// The STRANGER: holds no tokens, has no role, and only ever pays a fee. If this key can graduate
// the pool, then graduation is permissionless in the strongest sense.
const stranger = PrivateKey.fromRandom();
const strangerAddress = stranger.toPublicKey().toAddress();

// The reserve graduates HERE, fixed at deploy. Deliberately NOT the stranger.
const PAYOUT_PKH = pkhA;
const TERMS: PoolTerms = { k: K, supply: SUPPLY, payoutPkh: PAYOUT_PKH };

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};
const log = (s: string) => console.log(s);

async function woc(p: string, attempts = 7): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`${WOC}${p}`, { cache: 'no-store' }); if (r.ok || r.status === 404) return r; } catch { /* retry */ }
    await sleep(2500 * (i + 1));
  }
  return null;
}

const unlock = () => new P2PKH().unlock(priv, 'all', false);

async function main() {
  log(`wallet    : ${address}`);
  log(`payout    : ${PAYOUT_PKH.slice(0, 12)}… (fixed in the covenant at deploy)`);
  log(`stranger  : ${strangerAddress} — no tokens, no role, will trigger graduation`);
  log(`terms     : k=${K} supply=${SUPPLY} (must be bought out entirely)\n`);
  log('*** LIVE MAINNET ***\n');

  // ── SETUP ───────────────────────────────────────────────────────────────────
  log('▶ SETUP — deploy pool + funding');
  const genesisScriptHex = LedgerPoolClient.genesisScript(TERMS);
  const probe = new LedgerPoolClient('0'.repeat(64), TERMS);

  const fundA = 4000;
  const fundB = 4200;
  const fundStranger = 3000; // the stranger's ONLY stake in this: a fee, and it takes change back
  const total = SEED + fundA + fundB + fundStranger;

  const utxoRes = await woc(`/address/${address}/unspent`);
  if (!utxoRes || !utxoRes.ok) throw new Error('could not fetch wallet UTXOs');
  const utxos = (await utxoRes.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  const cands = utxos.filter((u) => u.value > total + 2000).sort((a, b) => b.value - a.value);
  let src: typeof cands[0] | undefined;
  for (const c of cands) {
    const sp = await woc(`/tx/${c.tx_hash}/${c.tx_pos}/spent`); // WoC lists spent outputs as unspent
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
  deploy.addOutput({ lockingScript: new P2PKH().lock(strangerAddress), satoshis: fundStranger }); // 3 → STRANGER
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), change: true }); // 4
  await deploy.fee();
  await deploy.sign();
  const genesisTxid = await probe.broadcast(deploy.toHex());
  log(`  ✓ pool ${genesisTxid.slice(0, 16)}…:0 @ ${SEED} sats`);
  await sleep(5000);

  const funding = (vout: number, satoshis: number): FundingInput => ({ sourceTransaction: deploy, outputIndex: vout, satoshis, unlock: unlock() });
  const pool = new LedgerPoolClient(genesisTxid, TERMS);

  // ── 1. refuse to graduate an unsold pool ────────────────────────────────────
  log('\n▶ 1. GUARD — graduation is impossible before the curve is bought out');
  const fresh = await pool.state();
  let early = '';
  try {
    await pool.buildGraduate({ funding: { sourceTransaction: deploy, outputIndex: 3, satoshis: fundStranger, unlock: new P2PKH().unlock(stranger, 'all', false) }, state: fresh });
  } catch (e) { early = e instanceof Error ? e.message : String(e); }
  check('refuses to graduate at sold 0', /not fully sold/i.test(early), early);

  // ── 2. buy the curve out completely ─────────────────────────────────────────
  log('\n▶ 2. SELL OUT — buy the curve to exactly sold == supply');
  const b1 = await pool.submitBuy({ delta: BUY_A, ownerPkh: pkhA, funding: funding(1, fundA), state: fresh });
  log(`  A bought ${BUY_A} for ${b1.cost} → ${b1.txid.slice(0, 16)}…`);
  await sleep(5000);
  const b2 = await pool.submitBuy({ delta: BUY_B, ownerPkh: pkhB, funding: funding(2, fundB) });
  log(`  B bought ${BUY_B} for ${b2.cost} → ${b2.txid.slice(0, 16)}…`);
  await sleep(5000);

  const soldOut = await pool.state();
  check('pool is fully sold', soldOut.sold === SUPPLY, `${soldOut.sold}/${SUPPLY}`);
  check('no supply remains to buy', soldOut.sold === SUPPLY);
  log(`  reserve at sell-out: ${soldOut.reserveSats} sats · holders: ${Object.keys(soldOut.balances).length}`);
  const finalLedger = { ...soldOut.balances }; // what real STAS would be minted against

  // a further buy must now be impossible — there is nothing left on the curve
  let overSupply = '';
  try { await pool.buildBuy({ delta: 1n, ownerPkh: pkhA, funding: funding(1, fundA), state: soldOut }); }
  catch (e) { overSupply = e instanceof Error ? e.message : String(e); }
  check('refuses to buy past a sold-out curve', /exceeds supply/i.test(overSupply), overSupply);

  // ── 3. a STRANGER graduates it ──────────────────────────────────────────────
  log('\n▶ 3. GRADUATE — triggered by the stranger (no tokens, no role, no signature required)');
  const strangerFunding: FundingInput = {
    sourceTransaction: deploy, outputIndex: 3, satoshis: fundStranger,
    unlock: new P2PKH().unlock(stranger, 'all', false),
  };
  const grad = await pool.buildGraduate({
    funding: strangerFunding,
    changeScriptHex: `76a914${Buffer.from(stranger.toPublicKey().toHash() as number[]).toString('hex')}88ac`,
    state: soldOut,
  });
  log(`  releasing ${grad.released} sats · ${grad.rawTx.length / 2} bytes · interpreter ✓`);
  const gradTxid = await pool.broadcast(grad.rawTx);
  log(`  ✓ graduated: ${gradTxid}`);
  await sleep(8000);

  // ── 4. verify ON CHAIN where the money actually went ────────────────────────
  log('\n▶ 4. VERIFY — the reserve went to the COMMITTED payout, not the graduator');
  const gRes = await woc(`/tx/hash/${gradTxid}`);
  const gTx = gRes && gRes.ok ? ((await gRes.json()) as any) : null;
  if (!gTx) { check('graduation tx readable on chain', false); }
  else {
    const payoutScript = `76a914${PAYOUT_PKH}88ac`;
    const toPayout = (gTx.vout ?? []).filter((o: any) => (o.scriptPubKey?.hex ?? '').toLowerCase() === payoutScript)
      .reduce((s: number, o: any) => s + Math.round((o.value ?? 0) * 1e8), 0);
    const strangerPkh = Buffer.from(stranger.toPublicKey().toHash() as number[]).toString('hex');
    const toStranger = (gTx.vout ?? []).filter((o: any) => (o.scriptPubKey?.hex ?? '').toLowerCase() === `76a914${strangerPkh}88ac`)
      .reduce((s: number, o: any) => s + Math.round((o.value ?? 0) * 1e8), 0);
    const totalOut = (gTx.vout ?? []).reduce((s: number, o: any) => s + Math.round((o.value ?? 0) * 1e8), 0);
    log(`  payout ${PAYOUT_PKH.slice(0, 10)}… received ${toPayout} sats · stranger put in ${fundStranger}, got back ${toStranger} (own change)`);
    check('the full reserve went to the committed payout', toPayout === grad.released, `${toPayout} vs ${grad.released}`);
    // The real property is NOT "the stranger received less than the reserve" — its change comes
    // from its own funding input, so those are unrelated amounts. What must hold is that the
    // graduator EXTRACTED NOTHING: it is strictly out of pocket by the miner fee.
    check('the graduator is net NEGATIVE (paid to graduate, extracted nothing)',
      toStranger < fundStranger, `got back ${toStranger} of its own ${fundStranger}`);
    check('the payout destination is NOT the graduator', PAYOUT_PKH.toLowerCase() !== strangerPkh.toLowerCase());
    // nothing leaked to a third destination: every satoshi is either the payout or the graduator's change
    check('no value leaked to any other destination', totalOut === toPayout + toStranger, `${totalOut} vs ${toPayout + toStranger}`);
    check('output 0 is the payout (pinned by the covenant)', (gTx.vout ?? [])[0]?.scriptPubKey?.hex?.toLowerCase() === payoutScript);
  }

  // ── 5. terminal state + the ledger survives ─────────────────────────────────
  log('\n▶ 5. TERMINAL — re-resolve from chain after the pool UTXO is gone');
  const after = await resolveLedgerPool(genesisTxid, TERMS);
  if ('error' in after) { check('pool still resolves after graduation', false, after.error); }
  else {
    check('pool reports graduated', after.graduated === true);
    check('final sold survives', after.sold === SUPPLY, `${after.sold}`);
    check('final ledger survives (holder balances still reconstructible)',
      JSON.stringify(Object.fromEntries(Object.entries(after.balances).map(([k, v]) => [k, v.toString()])))
      === JSON.stringify(Object.fromEntries(Object.entries(finalLedger).map(([k, v]) => [k, v.toString()]))));
    check('A balance intact', after.balances[pkhA] === BUY_A, `${after.balances[pkhA]}`);
    check('B balance intact', after.balances[pkhB] === BUY_B, `${after.balances[pkhB]}`);
    log(`  final ledger (what real STAS is minted against): ${Object.entries(after.balances).map(([k, v]) => `${k.slice(0, 10)}…=${v}`).join(', ')}`);
  }

  // graduating twice must be impossible
  let twice = '';
  try {
    const s2 = await pool.state();
    await pool.buildGraduate({ funding: strangerFunding, state: s2 });
  } catch (e) { twice = e instanceof Error ? e.message : String(e); }
  check('refuses to graduate twice', /already graduated/i.test(twice), twice);

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  log(`graduation: https://whatsonchain.com/tx/${gradTxid}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
