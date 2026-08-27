/**
 * verify-reconstruct-mainnet.ts — LIVE MAINNET proof of DB-free ledger resolution (ADR-027 phase 2).
 *
 * Phase 1 proved the reconstruction offline (`verify-reconstruct.ts`, 17/17) against synthesised
 * unlock scripts. This proves it against the real chain: deploy a small LedgerPool, put a real
 * multi-holder op history on mainnet (buy → buy → sell), then throw away everything we knew and
 * rebuild the pool's entire state from `resolveLedgerPool(genesisTxid, terms)` — WhatsOnChain only,
 * NO database — asserting the live outpoint, reserve, `sold`, every holder balance, and a
 * byte-exact match between the reconstruction and the on-chain tip's locking script.
 *
 * Money: real sats from the test CLIENT flat key (gitignored `.env`, never printed). Tiny pool —
 * the whole run costs a few thousand satoshis, and the sell returns most of it. Every broadcast is
 * gated on `validateAssembledCovenantInput` (the @bsv/sdk interpreter over the exact bytes we are
 * about to send), and `--dry` builds + validates the whole run without broadcasting anything.
 *
 *   node service/dist/service/verify-reconstruct-mainnet.js --dry   # build + interpreter-check only
 *   node service/dist/service/verify-reconstruct-mainnet.js         # live mainnet
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { computeBuySpend, computeSellDigest, computeSellUnlock, genesisPoolScript } from './ledgerState';
import { validateAssembledCovenantInput } from '../src/covenant';
import { resolveLedgerPool, ResolvedLedgerPool } from './resolveLedgerPool';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const DRY = process.argv.includes('--dry');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── pool terms (immutable, baked into the covenant at deploy) ─────────────────
const K = 1n;
const SUPPLY = 100n;
const SEED = 546; // dust seed reserve
const FEE_RATE = 0.15; // sat/byte — above the 0.1 the repo uses elsewhere; these txs are ~KBs
const cost = (sold: bigint, d: bigint) => (K * d * (2n * sold + d + 1n)) / 2n;

// The op history we will put on chain. Chosen so every curve refund clears the 546-sat dust
// floor, and so the ledger exercises what actually breaks: two distinct holders, and a sell
// that debits the FIRST holder after a second holder was inserted (HashedMap ordering).
const BUY_A = 40n; // cost 820   → reserve 1366
const BUY_B = 20n; // cost 1010  → reserve 2376
const SELL_A = 30n; // refund 1365 → reserve 1011 ; final: A=10, B=20, sold=30

// ── client flat key (test wallet) — NEVER printed ─────────────────────────────
const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) {
  console.error('❌ TEST_CLIENT_KEY missing from apps/web/.env (run: pnpm test:client)');
  process.exit(1);
}
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const clientPkh = Buffer.from(priv.toPublicKey().toHash() as number[]).toString('hex');
// Second holder: only ever CREDITED (never sells), so a public pkh is all we need.
const holderB = PrivateKey.fromRandom();
const bPkh = Buffer.from(holderB.toPublicKey().toHash() as number[]).toString('hex');
const payoutPkh = clientPkh; // graduation payout (not exercised here)

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); }
  else { fail++; console.log('  [FAIL]', n, extra); }
};
const log = (s: string) => console.log(s);

// ── WoC ───────────────────────────────────────────────────────────────────────
async function woc(path: string, attempts = 5): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${WOC}${path}`, { cache: 'no-store' });
      if (res.ok || res.status === 404) return res;
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

async function fetchTxHex(txid: string): Promise<string | null> {
  const res = await woc(`/tx/${txid}/hex`);
  if (!res || !res.ok) return null;
  return (await res.text()).trim();
}

async function broadcast(rawTx: string, label: string): Promise<string> {
  if (DRY) {
    const txid = Transaction.fromHex(rawTx).id('hex') as string;
    log(`  (dry) would broadcast ${label}: ${txid} — ${rawTx.length / 2} bytes`);
    return txid;
  }
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${WOC}/tx/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: rawTx }),
      });
      const body = (await res.text()).trim();
      if (res.ok) {
        const txid = body.replace(/"/g, '');
        log(`  ✓ broadcast ${label}: ${txid}`);
        return txid;
      }
      // definitive rejection → stop; transient (429/5xx) → retry
      if (!/rate|limit|timeout|503|502|500/i.test(body) && res.status !== 429) {
        throw new Error(`broadcast ${label} rejected: ${body}`);
      }
    } catch (e) {
      if (i === 4) throw e;
    }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`broadcast ${label} failed after retries`);
}

/** Build a pool-spending tx: [covenant input (raw unlock), P2PKH funding input] -> outputs. */
async function buildPoolSpend(args: {
  poolTxid: string; poolVout: number; poolScriptHex: string; poolSats: number; unlockingHex: string;
  fundingTx: Transaction; fundingVout: number;
  outputs: { scriptHex: string; satoshis: number }[];
}): Promise<{ rawTx: string; txid: string; tx: Transaction }> {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: args.poolTxid, sourceOutputIndex: args.poolVout, unlockingScript: Script.fromHex(args.unlockingHex), sequence: 0xffffffff });
  tx.addInput({ sourceTransaction: args.fundingTx, sourceOutputIndex: args.fundingVout, unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false), sequence: 0xffffffff });
  for (const o of args.outputs) tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.satoshis });
  await tx.sign();
  const rawTx = tx.toHex();
  // THE pre-broadcast guard: run the real bytes through the @bsv/sdk interpreter.
  const v = validateAssembledCovenantInput(rawTx, { scriptHex: args.poolScriptHex, satoshis: args.poolSats }, 0);
  if (!v.ok) throw new Error(`covenant input failed the interpreter: ${v.error}`);
  return { rawTx, txid: tx.id('hex') as string, tx };
}

const p2pkhHex = (pkh: string) => `76a914${pkh}88ac`;

/**
 * Assert a resolved pool against the expected end state. Shared by the full run and by
 * `--resolve <genesisTxid>`, which re-verifies an already-deployed pool (the real client
 * read path: a genesis txid + the covenant terms, and nothing else).
 */
function assertResolved(
  resolved: ResolvedLedgerPool,
  expect: { tipTxid?: string; reserve: number; sold: bigint; aBal: bigint; bBal: bigint; tipScriptHex?: string; aPkh: string; bPkh: string },
) {
  log(`  resolved: tip ${resolved.txid.slice(0, 12)}…:${resolved.vout} · reserve ${resolved.reserveSats} · sold ${resolved.sold} · ${resolved.hops} hops`);
  if (expect.tipTxid) check('tip outpoint is the sell successor', resolved.txid === expect.tipTxid && resolved.vout === 0, `${resolved.txid.slice(0, 12)}…:${resolved.vout} vs ${expect.tipTxid.slice(0, 12)}…:0`);
  check('reserve reconstructed', resolved.reserveSats === expect.reserve, `${resolved.reserveSats} vs ${expect.reserve}`);
  check('sold reconstructed', resolved.sold === expect.sold, `${resolved.sold} vs ${expect.sold}`);
  check('holder A balance', resolved.balances[expect.aPkh] === expect.aBal, `${resolved.balances[expect.aPkh]} vs ${expect.aBal}`);
  check('holder B balance', resolved.balances[expect.bPkh] === expect.bBal, `${resolved.balances[expect.bPkh]} vs ${expect.bBal}`);
  check('holder count', Object.keys(resolved.balances).length === 2, `${Object.keys(resolved.balances).length}`);
  check('op history length', resolved.history.length === 3, `${resolved.history.length}`);
  check('op order + signs', resolved.history[0]?.delta === BUY_A && resolved.history[1]?.delta === BUY_B && resolved.history[2]?.delta === -SELL_A);
  if (expect.tipScriptHex) {
    // the decisive one: the reconstruction byte-matches what is actually locked on chain
    check('reconstructed script BYTE-MATCHES the on-chain tip', resolved.scriptHex.toLowerCase() === expect.tipScriptHex.toLowerCase());
  }
  check('not graduated', resolved.graduated === false);
}

/**
 * `--resolve <genesisTxid>` — re-verify an already-deployed pool from chain ONLY.
 *
 * This is the true client read path, and a stricter test than the full run: the only local
 * inputs are the genesis txid and the covenant terms (k, supply, payoutPkh — all public and
 * immutable). Holder B's identity is not known here at all — it was a throwaway key whose pkh
 * we never kept — so it has to come back out of the blockchain, which is the entire claim.
 */
async function resolveOnly(genesisTxid: string) {
  const aPkh = clientPkh;
  log(`▶ RESOLVE-ONLY — rebuilding ${genesisTxid.slice(0, 12)}… from chain (no DB, no local state)`);
  log(`  terms: k=${K} supply=${SUPPLY} payoutPkh=${aPkh.slice(0, 12)}…`);
  log('  holder B is UNKNOWN locally — it must be recovered from chain');
  const resolved = await resolveLedgerPool(genesisTxid, { k: K, supply: SUPPLY, payoutPkh: aPkh });
  if ('error' in resolved) {
    check('resolveLedgerPool succeeded', false, resolved.error);
  } else {
    // fetch the tip's REAL on-chain script so the byte-match is against the chain, not our maths
    const res = await woc(`/tx/hash/${resolved.txid}`);
    const tipTx = res && res.ok ? ((await res.json()) as any) : null;
    const onChainScript = (tipTx?.vout ?? []).find((o: any) => o.n === resolved.vout)?.scriptPubKey?.hex ?? '';
    const recoveredB = Object.keys(resolved.balances).find((p) => p !== aPkh) ?? '';
    log(`  recovered holder B from chain: ${recoveredB.slice(0, 12)}… = ${resolved.balances[recoveredB]}`);
    check('holder B recovered from chain alone', /^[0-9a-f]{40}$/.test(recoveredB));
    assertResolved(resolved, {
      reserve: 1011, sold: BUY_A + BUY_B - SELL_A, aBal: BUY_A - SELL_A, bBal: BUY_B,
      tipScriptHex: onChainScript, aPkh, bPkh: recoveredB,
    });
  }
  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

async function main() {
  const rIdx = process.argv.indexOf('--resolve');
  if (rIdx >= 0) {
    const g = process.argv[rIdx + 1];
    if (!g || !/^[0-9a-fA-F]{64}$/.test(g)) { console.error('usage: --resolve <genesisTxid>'); process.exit(1); }
    return resolveOnly(g);
  }
  log(`client address: ${address}`);
  log(`pool terms: k=${K} supply=${SUPPLY} payoutPkh=${payoutPkh.slice(0, 12)}…`);
  log(`holders: A=${clientPkh.slice(0, 12)}… (client)  B=${bPkh.slice(0, 12)}… (credit-only)`);
  log(`plan: A buys ${BUY_A} (cost ${cost(0n, BUY_A)}) · B buys ${BUY_B} (cost ${cost(BUY_A, BUY_B)}) · A sells ${SELL_A}`);
  log(DRY ? '\n*** DRY RUN — nothing will be broadcast ***\n' : '\n*** LIVE MAINNET — real sats ***\n');

  const genesisScriptHex = genesisPoolScript(K, SUPPLY, payoutPkh);
  log(`genesis pool script: ${genesisScriptHex.length / 2} bytes`);

  // ── measure: build the buy/sell txs against a placeholder outpoint to learn real sizes,
  // so the deploy can size each funding output correctly (the SELL cannot carry change).
  log('\n▶ MEASURE — sizing the covenant txs before committing funds');
  const FAKE = 'f'.repeat(64);
  const m1 = computeBuySpend({ k: K, supply: SUPPLY, payoutPkh, history: [], ownerPkh: clientPkh, delta: BUY_A, poolTxid: FAKE, poolVout: 0, reserveBefore: SEED, newReserve: SEED + Number(cost(0n, BUY_A)) });
  const measuredBuySize = (m1.unlockingHex.length + m1.nextLockingHex.length) / 2 + 400; // + inputs/outputs overhead
  const histAfterBuys = [{ ownerPkh: clientPkh, delta: BUY_A.toString() }, { ownerPkh: bPkh, delta: BUY_B.toString() }];
  const mSell = computeSellDigest({ k: K, supply: SUPPLY, payoutPkh, history: histAfterBuys, ownerPkh: clientPkh, amount: SELL_A, poolTxid: FAKE, poolVout: 0, reserveBefore: SEED + Number(cost(0n, BUY_A)) + Number(cost(BUY_A, BUY_B)), payoutScriptHex: p2pkhHex(clientPkh) });
  const measuredSellSize = (mSell.nextLockingHex.length) / 2 + 12000; // unlock ~11KB + overhead
  const buyFee = Math.ceil(measuredBuySize * FEE_RATE);
  const sellFee = Math.ceil(measuredSellSize * FEE_RATE);
  log(`  buy  ≈ ${measuredBuySize} bytes → fee ${buyFee} sats`);
  log(`  sell ≈ ${measuredSellSize} bytes → fee ${sellFee} sats`);

  // funding outputs the deploy must create (buys carry change, so a little slack is fine;
  // the sell's fee input is consumed WHOLE as the miner fee, so it must be exact).
  const fundA = Number(cost(0n, BUY_A)) + buyFee;
  const fundB = Number(cost(BUY_A, BUY_B)) + buyFee;
  const fundSell = sellFee;
  const totalOut = SEED + fundA + fundB + fundSell;
  log(`  deploy will lock ${SEED} (pool) + fund ${fundA} / ${fundB} / ${fundSell} = ${totalOut} sats`);

  // ── STEP 1: DEPLOY the genesis pool + the funding outputs ────────────────────
  log('\n▶ STEP 1 — DEPLOY genesis pool');
  const utxoRes = await woc(`/address/${address}/unspent`);
  if (!utxoRes || !utxoRes.ok) throw new Error('could not fetch client UTXOs');
  const utxos = (await utxoRes.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  const funder = utxos.filter((u) => u.height > 0 && u.value > totalOut + 1000).sort((a, b) => b.value - a.value)[0];
  if (!funder) throw new Error(`no confirmed client UTXO larger than ${totalOut + 1000} sats`);
  log(`  funding UTXO ${funder.tx_hash.slice(0, 12)}…:${funder.tx_pos} = ${funder.value} sats`);
  const funderHex = await fetchTxHex(funder.tx_hash);
  if (!funderHex) throw new Error('could not fetch funding parent tx');

  const deploy = new Transaction();
  deploy.addInput({ sourceTransaction: Transaction.fromHex(funderHex), sourceOutputIndex: funder.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false), sequence: 0xffffffff });
  deploy.addOutput({ lockingScript: Script.fromHex(genesisScriptHex), satoshis: SEED }); // vout 0 = the pool
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundA }); // vout 1
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundB }); // vout 2
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundSell }); // vout 3
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), change: true }); // vout 4
  await deploy.fee();
  await deploy.sign();
  const deployRaw = deploy.toHex();
  const genesisTxid = await broadcast(deployRaw, 'DEPLOY');
  log(`  genesis outpoint: ${genesisTxid}:0 @ ${SEED} sats`);
  if (!DRY) await sleep(4000);

  // ── STEP 2: BUY A ────────────────────────────────────────────────────────────
  log(`\n▶ STEP 2 — BUY: A credits ${BUY_A}`);
  const reserve1 = SEED + Number(cost(0n, BUY_A));
  const buy1 = computeBuySpend({ k: K, supply: SUPPLY, payoutPkh, history: [], ownerPkh: clientPkh, delta: BUY_A, poolTxid: genesisTxid, poolVout: 0, reserveBefore: SEED, newReserve: reserve1 });
  const buy1Change = fundA - Number(cost(0n, BUY_A)) - buyFee;
  const buy1Outs = [{ scriptHex: buy1.nextLockingHex, satoshis: reserve1 }];
  if (buy1Change >= 546) buy1Outs.push({ scriptHex: p2pkhHex(clientPkh), satoshis: buy1Change });
  const t1 = await buildPoolSpend({ poolTxid: genesisTxid, poolVout: 0, poolScriptHex: genesisScriptHex, poolSats: SEED, unlockingHex: buy1.unlockingHex, fundingTx: deploy, fundingVout: 1, outputs: buy1Outs });
  log(`  interpreter ✓ · ${t1.rawTx.length / 2} bytes · reserve ${SEED} → ${reserve1}`);
  const buy1Txid = await broadcast(t1.rawTx, 'BUY-A');
  if (!DRY) await sleep(4000);

  // ── STEP 3: BUY B ────────────────────────────────────────────────────────────
  log(`\n▶ STEP 3 — BUY: B credits ${BUY_B}`);
  const reserve2 = reserve1 + Number(cost(BUY_A, BUY_B));
  const histA = [{ ownerPkh: clientPkh, delta: BUY_A.toString() }];
  const buy2 = computeBuySpend({ k: K, supply: SUPPLY, payoutPkh, history: histA, ownerPkh: bPkh, delta: BUY_B, poolTxid: buy1Txid, poolVout: 0, reserveBefore: reserve1, newReserve: reserve2 });
  const buy2Change = fundB - Number(cost(BUY_A, BUY_B)) - buyFee;
  const buy2Outs = [{ scriptHex: buy2.nextLockingHex, satoshis: reserve2 }];
  if (buy2Change >= 546) buy2Outs.push({ scriptHex: p2pkhHex(clientPkh), satoshis: buy2Change });
  const t2 = await buildPoolSpend({ poolTxid: buy1Txid, poolVout: 0, poolScriptHex: buy1.nextLockingHex, poolSats: reserve1, unlockingHex: buy2.unlockingHex, fundingTx: deploy, fundingVout: 2, outputs: buy2Outs });
  log(`  interpreter ✓ · ${t2.rawTx.length / 2} bytes · reserve ${reserve1} → ${reserve2}`);
  const buy2Txid = await broadcast(t2.rawTx, 'BUY-B');
  if (!DRY) await sleep(4000);

  // ── STEP 4: SELL A (holder-signed) ───────────────────────────────────────────
  log(`\n▶ STEP 4 — SELL: A debits ${SELL_A} (holder-signed)`);
  const payoutScriptHex = p2pkhHex(clientPkh);
  const sellArgs = { k: K, supply: SUPPLY, payoutPkh, history: histAfterBuys, ownerPkh: clientPkh, amount: SELL_A, poolTxid: buy2Txid, poolVout: 0, reserveBefore: reserve2, payoutScriptHex };
  const dig = computeSellDigest(sellArgs);
  // the holder authorises the debit — this signature IS their claim to the balance
  const sigDer = B.crypto.ECDSA.sign(Buffer.from(dig.digestHex, 'hex'), B.PrivateKey.fromString(keyHex)).toDER().toString('hex');
  const sell = computeSellUnlock({ ...sellArgs, ownerPubHex: priv.toPublicKey().toString(), sigDerHex: sigDer });
  log(`  refund ${sell.refund} sats → ${address} · reserve ${reserve2} → ${dig.reserveAfter}`);
  const t3 = await buildPoolSpend({
    poolTxid: buy2Txid, poolVout: 0, poolScriptHex: buy2.nextLockingHex, poolSats: reserve2, unlockingHex: sell.unlockingHex,
    fundingTx: deploy, fundingVout: 3,
    // 0xc1 (ANYONECANPAY|ALL) pins EXACTLY these two outputs — no change is possible
    outputs: [{ scriptHex: sell.nextLockingHex, satoshis: dig.reserveAfter }, { scriptHex: payoutScriptHex, satoshis: Number(sell.refund) }],
  });
  log(`  interpreter ✓ · ${t3.rawTx.length / 2} bytes`);
  const sellTxid = await broadcast(t3.rawTx, 'SELL-A');

  if (DRY) {
    log('\n*** DRY RUN complete — all three covenant spends built and passed the interpreter. ***');
    log('Re-run without --dry to broadcast and prove the chain-only reconstruction.');
    return;
  }

  // ── STEP 5: RESOLVE FROM CHAIN ALONE ─────────────────────────────────────────
  log('\n▶ STEP 5 — RESOLVE the pool from chain ONLY (no DB, no local state)');
  log('  waiting for WhatsOnChain to index the chain…');
  await sleep(12000);

  let resolved = await resolveLedgerPool(genesisTxid, { k: K, supply: SUPPLY, payoutPkh });
  for (let i = 0; i < 5 && 'error' in resolved; i++) {
    log(`  not indexed yet (${resolved.error}) — retrying…`);
    await sleep(8000);
    resolved = await resolveLedgerPool(genesisTxid, { k: K, supply: SUPPLY, payoutPkh });
  }
  if ('error' in resolved) {
    check('resolveLedgerPool succeeded', false, resolved.error);
  } else {
    log(`  resolved: tip ${resolved.txid.slice(0, 12)}…:${resolved.vout} · reserve ${resolved.reserveSats} · sold ${resolved.sold} · ${resolved.hops} hops`);
    const expSold = BUY_A + BUY_B - SELL_A;
    check('tip outpoint is the sell successor', resolved.txid === sellTxid && resolved.vout === 0, `${resolved.txid.slice(0, 12)}…:${resolved.vout} vs ${sellTxid.slice(0, 12)}…:0`);
    check('reserve reconstructed', resolved.reserveSats === dig.reserveAfter, `${resolved.reserveSats} vs ${dig.reserveAfter}`);
    check('sold reconstructed', resolved.sold === expSold, `${resolved.sold} vs ${expSold}`);
    check('holder A balance', resolved.balances[clientPkh] === BUY_A - SELL_A, `${resolved.balances[clientPkh]} vs ${BUY_A - SELL_A}`);
    check('holder B balance', resolved.balances[bPkh] === BUY_B, `${resolved.balances[bPkh]} vs ${BUY_B}`);
    check('holder count', Object.keys(resolved.balances).length === 2, `${Object.keys(resolved.balances).length}`);
    check('op history length', resolved.history.length === 3, `${resolved.history.length}`);
    check('op order + signs', resolved.history[0]?.delta === BUY_A && resolved.history[1]?.delta === BUY_B && resolved.history[2]?.delta === -SELL_A);
    // the decisive one: the reconstruction byte-matches what is actually locked on chain
    check('reconstructed script BYTE-MATCHES the on-chain tip', resolved.scriptHex.toLowerCase() === sell.nextLockingHex.toLowerCase());
    check('not graduated', resolved.graduated === false);
  }

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n❌', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
