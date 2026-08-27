// operator-fuel.mjs — operator fee-fuel maintenance for the FLAT-KEY BASE address.
//
// The trade path funds every delivery (TX-B) and sell refund from spendable sats at the
// operator BASE P2PKH address (hash160(OPERATOR_KEY pubkey)). If those sats sit in ONE
// UTXO, a burst of trades chains it delivery→delivery→… and hits BSV's 25-unconfirmed-
// ancestor mempool wall — the jam that stranded local testing. This tool:
//
//   status (default) — report base-UTXO health: confirmed vs unconfirmed, count, value,
//                      and whether any single UTXO is carrying the whole balance.
//   split [K]        — split the largest CONFIRMED unspent base UTXO into K equal shallow
//                      fuel outputs back to base (depth-0 children of a confirmed tx). A
//                      burst then consumes K PARALLEL shallow UTXOs instead of one deep
//                      chain. Flat-key signed (@bsv/sdk P2PKH, FORKID), broadcast via WoC.
//                      Prints the raw hex too, in case WoC rate-limits.
//   drain <address>  — sweep ALL confirmed base sats to <address> (recover test funds).
//
// Append `dry` to split/drain to build + print the tx WITHOUT broadcasting (preview).
//
// Run:  pnpm --filter @launchpad/web operator:fuel                 # health report
//       pnpm --filter @launchpad/web operator:fuel -- split 8      # split into 8 fuel UTXOs
//       pnpm --filter @launchpad/web operator:fuel -- drain <addr> # sweep all funds out
//
// Moves ONLY the operator's own sats (base → base). No user funds. Never prints the key.
import fs from 'node:fs';
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk';

const CHAIN = 'main';
const WOC = `https://api.whatsonchain.com/v1/bsv/${CHAIN}`;
const FEE_RATE = 100; // sat/kb = 0.1 sat/byte (matches CURVE_FEE_RATE; safe vs eviction)
const MIN_FUEL = 1200; // don't create fuel outputs smaller than this (dust-ish for a delivery fee)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => a !== '--');
const mode = args[0] === 'split' ? 'split' : args[0] === 'drain' ? 'drain' : 'status';
const K = Math.max(2, Math.min(20, Number(args[1] ?? 8) || 8));
const DRAIN_TO = mode === 'drain' ? args[1] : null; // address to sweep ALL base funds to
const DRY = args.includes('dry'); // build + print the tx but DON'T broadcast

// ── operator flat key (base address) from .env — never printed ────────────────
const ENV_PATH = new URL('../.env', import.meta.url);
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^OPERATOR_KEY=(.+)$/m)?.[1] ?? '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) { console.error('❌ OPERATOR_KEY missing/!hex in apps/web/.env'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
console.log('operator base address:', address, `(mode: ${mode}${mode === 'split' ? ` K=${K}` : ''})`);

// ── WoC helpers ───────────────────────────────────────────────────────────────
async function wocJson(path) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${WOC}${path}`).catch(() => null);
    if (res && res.status === 429) { await sleep(2500); continue; }
    if (!res || !res.ok) return null;
    return res.json().catch(() => null);
  }
  return null;
}
async function wocRawTx(txid) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${WOC}/tx/${txid}/hex`).catch(() => null);
    if (res && res.status === 429) { await sleep(2500); continue; }
    if (!res || !res.ok) return null;
    return (await res.text()).trim();
  }
  return null;
}
async function wocPush(hex) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${WOC}/tx/raw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }),
    }).catch((e) => ({ status: 0, ok: false, text: async () => String(e.message) }));
    const body = (await res.text()).trim().replace(/\s+/g, ' ').slice(0, 80);
    if (res.status === 429) { await sleep(3000); continue; }
    if (res.ok || /already|known/i.test(body)) return { ok: true, body };
    return { ok: false, body };
  }
  return { ok: false, body: 'rate-limited (gave up)' };
}
// WoC lists spent outputs as unspent (field-notes gotcha) — confirm each is truly unspent.
// WoC `/tx/{txid}/{vout}/spent` returns 404 when UNSPENT, and a JSON body (spending tx)
// when SPENT. Mirrors isOutputUnspent in settle-actions.ts. Returns true | false | null.
async function isUnspent(txid, vout) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${WOC}/tx/${txid}/${vout}/spent`, { cache: 'no-store' }).catch(() => null);
    if (res && res.status === 404) return true;   // 404 = unspent
    if (res && res.ok) return false;              // 200 = spent
    if (res && res.status === 429) { await sleep(2500); continue; }
    await sleep(1200);                            // transient → retry
  }
  return null;                                     // unverifiable
}

// normalize a WoC unspent row to {txid, vout, satoshis, height}
const norm = (u) => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: Number(u.value), height: u.height ?? 0 });

async function fetchBase() {
  const conf = (await wocJson(`/address/${address}/confirmed/unspent`))?.result ?? (await wocJson(`/address/${address}/confirmed/unspent`)) ?? [];
  const unconf = (await wocJson(`/address/${address}/unconfirmed/unspent`))?.result ?? (await wocJson(`/address/${address}/unconfirmed/unspent`)) ?? [];
  const confirmed = (Array.isArray(conf) ? conf : []).map(norm);
  const unconfirmed = (Array.isArray(unconf) ? unconf : []).map(norm);
  return { confirmed, unconfirmed };
}

// ── STATUS ─────────────────────────────────────────────────────────────────────
async function status() {
  const { confirmed, unconfirmed } = await fetchBase();
  const sum = (a) => a.reduce((s, u) => s + u.satoshis, 0);
  // verify the confirmed set is really unspent (WoC over-reports)
  const checked = [];
  for (const u of confirmed) { const un = await isUnspent(u.txid, u.vout); await sleep(150); checked.push({ ...u, unspent: un }); }
  const spendable = checked.filter((u) => u.unspent === true);
  console.log(`\n  confirmed UTXOs   : ${confirmed.length}  (${sum(confirmed)} sats)`);
  console.log(`    verified-unspent: ${spendable.length}  (${sum(spendable)} sats)  ← the real fuel`);
  console.log(`  unconfirmed UTXOs : ${unconfirmed.length}  (${sum(unconfirmed)} sats)`);
  const biggest = spendable.slice().sort((a, b) => b.satoshis - a.satoshis)[0];
  if (spendable.length === 0) {
    console.log('\n  ⚠️  NO confirmed spendable fuel — the trade path cannot fund. Send fresh sats to the base address.');
  } else if (spendable.length === 1) {
    console.log(`\n  ⚠️  All fuel is in ONE UTXO (${biggest.satoshis} sats). A burst will chain it deep and jam.`);
    console.log(`     → run: pnpm --filter @launchpad/web operator:fuel -- split ${Math.min(8, Math.max(2, Math.floor(biggest.satoshis / 3000)))}`);
  } else {
    console.log(`\n  ✅ ${spendable.length} parallel confirmed fuel UTXOs — a burst can fan across them.`);
  }
  console.log('\n  top confirmed spendable:');
  for (const u of spendable.slice().sort((a, b) => b.satoshis - a.satoshis).slice(0, 8)) console.log(`    ${u.txid}:${u.vout}  ${u.satoshis} sats  (height ${u.height})`);
}

// ── SPLIT ──────────────────────────────────────────────────────────────────────
async function split() {
  const { confirmed } = await fetchBase();
  // pick the largest CONFIRMED, verified-unspent UTXO (shallow root for the fuel outputs)
  const sorted = confirmed.slice().sort((a, b) => b.satoshis - a.satoshis);
  let src = null;
  for (const u of sorted) { const un = await isUnspent(u.txid, u.vout); await sleep(150); if (un === true) { src = u; break; } }
  if (!src) { console.error('❌ no confirmed, verified-unspent base UTXO to split — send fresh sats to the base address first.'); process.exit(1); }
  console.log(`\n  splitting ${src.txid}:${src.vout} (${src.satoshis} sats) into ${K} fuel outputs…`);

  const parentHex = await wocRawTx(src.txid);
  if (!parentHex) { console.error('❌ could not fetch the source tx raw hex from WoC'); process.exit(1); }
  const sourceTransaction = Transaction.fromHex(parentHex);

  const tx = new Transaction();
  tx.addInput({ sourceTransaction, sourceOutputIndex: src.vout, unlockingScriptTemplate: new P2PKH().unlock(priv) });
  // K-1 equal fuel outputs + 1 change output (absorbs the fee remainder); each ≥ MIN_FUEL.
  const per = Math.floor(src.satoshis / K);
  if (per < MIN_FUEL) { console.error(`❌ ${src.satoshis}/${K} = ${per} sats/output is below MIN_FUEL ${MIN_FUEL}; use a smaller K or fund more.`); process.exit(1); }
  for (let i = 0; i < K - 1; i++) tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: per });
  tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true }); // Kth output = change, pays the fee
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE));
  await tx.sign();
  const rawHex = tx.toHex();
  const txid = tx.id('hex');
  console.log(`  built split tx ${txid} (${rawHex.length / 2} bytes) → ${K - 1}×${per} sats + change`);
  console.log(`  RAW TX HEX: ${rawHex}`);
  if (DRY) { console.log('\n  (dry run — NOT broadcast. Re-run without `dry` to send.)'); return; }

  const r = await wocPush(rawHex);
  if (r.ok) {
    console.log(`\n  ✅ broadcast: ${txid} — ${K} shallow fuel UTXOs now confirming.`);
    console.log('     re-run `operator:fuel` (status) after ~1 block to confirm the fan-out.');
  } else {
    console.log(`\n  ✗ WoC rejected: ${r.body}`);
    console.log('     (push the RAW TX HEX above manually via WhatsOnChain if this was a rate-limit)');
    process.exit(1);
  }
}

// ── DRAIN ────────────────────────────────────────────────────────────────────
// Sweep ALL confirmed, verified-unspent base sats to a target address (recover test
// funds). One output to the target (change:true absorbs total − fee). Flat-key signed.
async function drain() {
  if (!DRAIN_TO || DRAIN_TO.length < 26 || DRAIN_TO.length > 35) {
    console.error('❌ usage: operator:fuel -- drain <destination-address> [dry]'); process.exit(1);
  }
  const { confirmed } = await fetchBase();
  const inputs = [];
  for (const u of confirmed) { const un = await isUnspent(u.txid, u.vout); await sleep(150); if (un === true) inputs.push(u); }
  if (inputs.length === 0) { console.error('❌ no confirmed, verified-unspent base UTXOs to sweep.'); process.exit(1); }
  const total = inputs.reduce((s, u) => s + u.satoshis, 0);
  console.log(`\n  sweeping ${inputs.length} UTXO(s) (${total} sats) → ${DRAIN_TO}…`);

  const tx = new Transaction();
  for (const u of inputs) {
    const parentHex = await wocRawTx(u.txid); await sleep(150);
    if (!parentHex) { console.error(`❌ could not fetch raw hex for ${u.txid}`); process.exit(1); }
    tx.addInput({ sourceTransaction: Transaction.fromHex(parentHex), sourceOutputIndex: u.vout, unlockingScriptTemplate: new P2PKH().unlock(priv) });
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(DRAIN_TO), change: true }); // sweep-all: total − fee
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE));
  await tx.sign();
  const rawHex = tx.toHex();
  const txid = tx.id('hex');
  console.log(`  built sweep tx ${txid} (${rawHex.length / 2} bytes)`);
  console.log(`  RAW TX HEX: ${rawHex}`);
  if (DRY) { console.log('\n  (dry run — NOT broadcast. Re-run without `dry` to send.)'); return; }
  const r = await wocPush(rawHex);
  console.log(r.ok ? `\n  ✅ swept: ${txid} — all base funds → ${DRAIN_TO}` : `\n  ✗ WoC rejected: ${r.body}`);
  if (!r.ok) process.exit(1);
}

if (mode === 'split') await split();
else if (mode === 'drain') await drain();
else await status();
process.exit(0);
