/**
 * verify-open-client-mainnet.ts — the PHASE 3 ACCEPTANCE TEST (ADR-027).
 *
 * Proves the "anyone can build a UI over it" claim by doing a full mainnet round trip using
 * ONLY the open client (`LedgerPoolClient`) and a wallet. Deliberately absent from this file:
 * the launchpad app, its server actions, Prisma, the operator key, and any stored pool state.
 * The client is handed a genesis txid and the pool's public terms and nothing else — every
 * price, balance, outpoint and script comes back out of the blockchain.
 *
 * What it proves, in order:
 *   1. OPEN      — deploy a pool from `LedgerPoolClient.genesisScript(terms)` alone.
 *   2. READ      — `state()` resolves the fresh pool from chain (sold 0, reserve = seed).
 *   3. BUY       — a keyless credit, priced by the covenant.
 *   4. RE-READ   — a SECOND client instance, constructed from scratch, sees the buy.
 *   5. SELL      — holder-signed debit, NO operator co-signature anywhere in the path.
 *   6. FINAL     — a THIRD fresh client rebuilds the whole pool and byte-matches the chain.
 *   7. GUARDS    — the client refuses an overspend, an unaffordable buy, and a dust-refund sell.
 *
 * Money: the test CLIENT flat key (gitignored `.env`, never printed). `--dry` builds and
 * interpreter-checks everything without broadcasting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { LedgerPoolClient, PoolTerms, FundingInput, Holder } from './ledgerClient';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const DRY = process.argv.includes('--dry');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const K = 1n;
const SUPPLY = 60n;
const SEED = 546;
const BUY = 40n; // cost 820
const SELL = 25n; // at sold=40 → newSold 15, refund 25*(30+25+1)/2 = 700 ≥ dust

// ── wallet (flat key) — NEVER printed ─────────────────────────────────────────
const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing from apps/web/.env'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const myPkh = Buffer.from(priv.toPublicKey().toHash() as number[]).toString('hex');

const TERMS: PoolTerms = { k: K, supply: SUPPLY, payoutPkh: myPkh };

/** The holder adapter: a public key and one digest signature. The client never sees the key. */
const holder: Holder = {
  ownerPkh: myPkh,
  ownerPubHex: priv.toPublicKey().toString(),
  async signDigest(digestHex: string) {
    return B.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), B.PrivateKey.fromString(keyHex)).toDER().toString('hex');
  },
};

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};
const log = (s: string) => console.log(s);

async function woc(p: string, attempts = 5): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`${WOC}${p}`, { cache: 'no-store' }); if (r.ok || r.status === 404) return r; } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

/** Assert the client REFUSES something the covenant would reject (guards are part of the API). */
async function refuses(name: string, fn: () => Promise<unknown>, expect: RegExp) {
  try { await fn(); check(name, false, 'expected a refusal, got success'); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, expect.test(msg), `message was: ${msg}`);
  }
}

/**
 * `--resolve <genesisTxid> [supply]` — READ an existing pool through the open client and nothing
 * else. This is the plain client use case (the one a third-party UI would run on page load), and
 * it is also how anyone can re-verify a pool this harness created, long after the fact.
 */
async function resolveOnly(genesisTxid: string, supply: bigint) {
  const terms: PoolTerms = { k: K, supply, payoutPkh: myPkh };
  log(`▶ RESOLVE — reading ${genesisTxid.slice(0, 12)}… through LedgerPoolClient (chain only)`);
  const client = new LedgerPoolClient(genesisTxid, terms);
  const s = await client.state();
  log(`  tip      : ${s.txid.slice(0, 16)}…:${s.vout}`);
  log(`  sold     : ${s.sold}/${supply} · reserve ${s.reserveSats} sats`);
  log(`  history  : ${s.history.map((o) => (o.delta > 0n ? '+' : '') + o.delta).join(' ')}`);
  log(`  balances : ${Object.entries(s.balances).map(([k, v]) => `${k.slice(0, 10)}…=${v}`).join(', ') || '(none)'}`);
  check('hops walked == ops replayed', s.hops === s.history.length, `${s.hops} vs ${s.history.length}`);
  check('sold == sum of balances', s.sold === Object.values(s.balances).reduce((a, b) => a + b, 0n));
  const tipRes = await woc(`/tx/hash/${s.txid}`);
  const tipTx = tipRes && tipRes.ok ? ((await tipRes.json()) as any) : null;
  const onChain = (tipTx?.vout ?? []).find((o: any) => o.n === s.vout)?.scriptPubKey?.hex ?? '';
  check('reconstruction BYTE-MATCHES the on-chain tip', s.scriptHex.toLowerCase() === onChain.toLowerCase());
  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

async function main() {
  const rIdx = process.argv.indexOf('--resolve');
  if (rIdx >= 0) {
    const g = process.argv[rIdx + 1];
    const sup = process.argv[rIdx + 2];
    if (!g || !/^[0-9a-fA-F]{64}$/.test(g)) { console.error('usage: --resolve <genesisTxid> [supply]'); process.exit(1); }
    return resolveOnly(g, sup ? BigInt(sup) : SUPPLY);
  }
  log(`wallet: ${address}`);
  log(`terms:  k=${K} supply=${SUPPLY} payoutPkh=${myPkh.slice(0, 12)}…`);
  log(DRY ? '\n*** DRY RUN — nothing will be broadcast ***\n' : '\n*** LIVE MAINNET — open client only ***\n');

  // ── 1. OPEN: deploy from the client's genesis script ────────────────────────
  log('▶ 1. OPEN — deploy a pool using only LedgerPoolClient.genesisScript(terms)');
  const genesisScriptHex = LedgerPoolClient.genesisScript(TERMS);
  log(`  genesis script: ${genesisScriptHex.length / 2} bytes`);

  const probe = new LedgerPoolClient('0'.repeat(64), TERMS);
  // size the funding outputs the two trades will need (the sell's fee input must be EXACT)
  const buyFund = Number((K * BUY * (BUY + 1n)) / 2n) + 3600; // cost + generous fee (buy takes change)
  const sellFeeGuess = 8000; // generous placeholder; the exact fee is quoted later and change returns

  const utxoRes = await woc(`/address/${address}/unspent`);
  if (!utxoRes || !utxoRes.ok) throw new Error('could not fetch wallet UTXOs');
  const utxos = (await utxoRes.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  const need = SEED + buyFund + sellFeeGuess + 2000;
  // WoC's /unspent lists outputs it has already seen spent (a known trap — see the BSV field
  // notes). Verify each candidate against /spent before building, or the node answers with
  // `258: txn-mempool-conflict` at broadcast. 404 on /spent == genuinely unspent.
  // Unconfirmed (height 0) outputs are spendable — chaining through our own change beats
  // waiting for a block, and this harness spends its own deploy change on a re-run.
  const candidates = utxos.filter((u) => u.value > need).sort((a, b) => b.value - a.value);
  let src: typeof candidates[0] | undefined;
  for (const c of candidates) {
    const sp = await woc(`/tx/${c.tx_hash}/${c.tx_pos}/spent`);
    if (sp && sp.status === 404) { src = c; break; }
    log(`  skipping ${c.tx_hash.slice(0, 12)}…:${c.tx_pos} — already spent`);
  }
  if (!src) throw new Error(`no VERIFIED-unspent confirmed UTXO > ${need} sats`);
  const srcHexRes = await woc(`/tx/${src.tx_hash}/hex`);
  const srcHex = srcHexRes && srcHexRes.ok ? (await srcHexRes.text()).trim() : null;
  if (!srcHex) throw new Error('could not fetch parent tx');

  const deploy = new Transaction();
  deploy.addInput({ sourceTransaction: Transaction.fromHex(srcHex), sourceOutputIndex: src.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false), sequence: 0xffffffff });
  deploy.addOutput({ lockingScript: Script.fromHex(genesisScriptHex), satoshis: SEED }); // vout 0 — the pool
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: buyFund }); // vout 1 — buy funding
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: sellFeeGuess }); // vout 2 — placeholder
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
  await deploy.fee();
  await deploy.sign();

  let genesisTxid = deploy.id('hex') as string;
  if (!DRY) {
    genesisTxid = await probe.broadcast(deploy.toHex());
    log(`  ✓ deployed: ${genesisTxid}:0 @ ${SEED} sats`);
    await sleep(5000);
  } else {
    log(`  (dry) genesis would be ${genesisTxid}:0`);
  }

  const fundingFor = (vout: number, satoshis: number): FundingInput => ({
    sourceTransaction: deploy, outputIndex: vout, satoshis, unlock: new P2PKH().unlock(priv, 'all', false),
  });

  if (DRY) {
    log('\n*** DRY RUN: the open client needs the pool on chain to resolve state. ***');
    log('Deploy tx built + signed OK. Re-run without --dry for the full round trip.');
    return;
  }

  // ── 2. READ: a client that knows only the genesis txid + terms ──────────────
  log('\n▶ 2. READ — resolve the fresh pool from chain (no DB)');
  const pool = new LedgerPoolClient(genesisTxid, TERMS);
  let state = await pool.state();
  check('fresh pool: sold == 0', state.sold === 0n, `${state.sold}`);
  check('fresh pool: reserve == seed', state.reserveSats === SEED, `${state.reserveSats}`);
  check('fresh pool: no holders', Object.keys(state.balances).length === 0);
  check('fresh pool: tip is genesis', state.txid === genesisTxid && state.vout === 0);
  log(`  quote: buying ${BUY} costs ${pool.quoteBuy(state, BUY)} sats`);

  // ── 3. BUY (keyless) ────────────────────────────────────────────────────────
  log(`\n▶ 3. BUY — credit ${BUY} to ${myPkh.slice(0, 12)}… (keyless; covenant prices it)`);
  const buy = await pool.buildBuy({ delta: BUY, ownerPkh: myPkh, funding: fundingFor(1, buyFund), state });
  log(`  cost ${buy.cost} · reserve ${SEED} → ${buy.newReserve} · ${buy.rawTx.length / 2} bytes · interpreter ✓`);
  const buyTxid = await pool.broadcast(buy.rawTx);
  log(`  ✓ ${buyTxid}`);
  await sleep(6000);

  // ── 4. RE-READ from a brand-new client instance ─────────────────────────────
  log('\n▶ 4. RE-READ — a SECOND client, built from scratch, sees the buy');
  const pool2 = new LedgerPoolClient(genesisTxid, TERMS);
  state = await pool2.state();
  check('reader 2: sold == BUY', state.sold === BUY, `${state.sold}`);
  check('reader 2: balance credited', pool2.balanceOf(state, myPkh) === BUY, `${pool2.balanceOf(state, myPkh)}`);
  check('reader 2: tip moved to the buy', state.txid === buyTxid, `${state.txid.slice(0, 12)}…`);
  check('reader 2: reserve grew by the cost', state.reserveSats === SEED + Number(buy.cost), `${state.reserveSats}`);

  // ── 5. SELL (holder-signed, no operator) ────────────────────────────────────
  log(`\n▶ 5. SELL — debit ${SELL}, holder-signed (no operator co-signature exists here)`);
  const exactFee = await pool2.quoteSellFee({ amount: SELL, holder, state });
  log(`  sell fee input must be EXACTLY ${exactFee} sats (covenant pins 2 outputs → no change)`);
  // pre-size the fee UTXO from the deploy's placeholder output (the two-tx pattern a wallet needs)
  const feePrep = new Transaction();
  feePrep.addInput({ sourceTransaction: deploy, sourceOutputIndex: 2, unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false), sequence: 0xffffffff });
  feePrep.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: exactFee });
  const prepFee = Math.max(200, Math.ceil(300 * 0.15));
  const prepChange = sellFeeGuess - exactFee - prepFee;
  if (prepChange >= 546) feePrep.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: prepChange });
  await feePrep.sign();
  if (sellFeeGuess - exactFee < 0) throw new Error(`fee placeholder ${sellFeeGuess} < required ${exactFee}`);
  const feePrepTxid = await pool2.broadcast(feePrep.toHex());
  log(`  ✓ fee UTXO prepared: ${feePrepTxid}:0 = ${exactFee} sats`);
  await sleep(5000);

  const sellFunding: FundingInput = { sourceTransaction: feePrep, outputIndex: 0, satoshis: exactFee, unlock: new P2PKH().unlock(priv, 'all', false) };
  const sell = await pool2.buildSell({ amount: SELL, holder, funding: sellFunding });
  const sellSize = sell.rawTx.length / 2;
  log(`  refund ${sell.refund} → ${address} · reserve → ${sell.reserveAfter} · ${sellSize} bytes · interpreter ✓`);
  // the fee estimate drives a REQUIRED input value, so drift is a real bug, not cosmetics
  const actualRate = exactFee / sellSize;
  check(`sell fee estimate tracks the real tx size (${actualRate.toFixed(3)} sat/byte)`, actualRate >= 0.12 && actualRate <= 0.25, `${exactFee} sats over ${sellSize} bytes`);
  const sellTxid = await pool2.broadcast(sell.rawTx);
  log(`  ✓ ${sellTxid}`);
  await sleep(6000);

  // ── 6. FINAL: a third fresh client rebuilds everything ──────────────────────
  log('\n▶ 6. FINAL — a THIRD fresh client rebuilds the pool from chain');
  const pool3 = new LedgerPoolClient(genesisTxid, TERMS);
  const final = await pool3.state();
  const expSold = BUY - SELL;
  check('final: sold', final.sold === expSold, `${final.sold} vs ${expSold}`);
  check('final: holder balance', pool3.balanceOf(final, myPkh) === expSold, `${pool3.balanceOf(final, myPkh)}`);
  check('final: reserve', final.reserveSats === sell.reserveAfter, `${final.reserveSats} vs ${sell.reserveAfter}`);
  check('final: tip is the sell', final.txid === sellTxid && final.vout === 0);
  check('final: hops walked == ops replayed', final.hops === final.history.length, `${final.hops} hops vs ${final.history.length} ops`);
  check('final: history is [+BUY, -SELL]', final.history.length === 2 && final.history[0].delta === BUY && final.history[1].delta === -SELL);
  const tipRes = await woc(`/tx/hash/${final.txid}`);
  const tipTx = tipRes && tipRes.ok ? ((await tipRes.json()) as any) : null;
  const onChainScript = (tipTx?.vout ?? []).find((o: any) => o.n === final.vout)?.scriptPubKey?.hex ?? '';
  check('final: reconstruction BYTE-MATCHES the on-chain tip', final.scriptHex.toLowerCase() === onChainScript.toLowerCase());

  // ── 7. GUARDS ───────────────────────────────────────────────────────────────
  log('\n▶ 7. GUARDS — the client refuses what the covenant would reject');
  await refuses('refuses selling more than the holder owns',
    () => pool3.buildSell({ amount: expSold + 100n, holder, funding: sellFunding, state: final }), /insufficient balance/i);
  await refuses('refuses a buy beyond supply',
    () => pool3.buildBuy({ delta: SUPPLY, ownerPkh: myPkh, funding: fundingFor(1, buyFund), state: final }), /exceeds supply/i);
  await refuses('refuses an underfunded buy',
    () => pool3.buildBuy({ delta: 5n, ownerPkh: myPkh, funding: fundingFor(1, 10), state: final }), /short/i);
  await refuses('refuses a sell whose refund is dust',
    () => pool3.buildSell({ amount: 1n, holder, funding: sellFunding, state: final }), /dust/i);

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  log(`re-verify any time: --resolve ${genesisTxid}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
