/**
 * calibrate-fee-rate.ts — what fee rate do miners actually ACCEPT AND MINE for a pool-sized tx?
 *
 * ADR-031: the fee floor is the real constraint on the trustless curve, not the missing spread.
 * Every ADR-030 pool spend is ~24.7 KB, so at our chosen 0.15 sat/B a round trip costs 7,410 sats
 * — 74% of a 10,000-sat trade. That 0.15 was picked conservatively and never tested.
 *
 * TWO-PHASE ON PURPOSE. Broadcast acceptance only proves a transaction entered ONE node's mempool.
 * A transaction that is accepted but never mined is WORSE than an overpaid one: it sits in the
 * mempool, and for a covenant pool it blocks the chain of successors behind it. So:
 *
 *   phase A (`--probe`)  broadcast a pool-SIZED transaction at each candidate rate, record which
 *                        are accepted or rejected, and save the txids
 *   phase B (`--check`)  come back later and see which ones actually got MINED
 *
 * Rejection is free — a rejected transaction pays no fee — so probing downward costs nothing but
 * the fees of the probes that succeed. Probes are self-sends padded with OP_RETURN to pool size,
 * so they mimic a real pool spend's economics without risking a real pool.
 *
 *   node service/dist/service/calibrate-fee-rate.js --probe
 *   node service/dist/service/calibrate-fee-rate.js --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


/**
 * Transaction size to probe at, in bytes. Defaults to an ADR-030 pool spend (~24.7KB, measured),
 * but is overridable with `--size N` because **the answer depends on it**: a node's absolute
 * minimum fee bites harder on a small transaction than a large one, so a rate proven mineable at
 * 24.7KB is NOT automatically mineable at Option B's ~7.4KB. Probe at the size you will actually
 * broadcast.
 */
const sizeArg = process.argv.indexOf('--size');
const POOL_TX_BYTES = sizeArg >= 0 ? Math.max(500, Number(process.argv[sizeArg + 1]) || 24_700) : 24_700;

/** Probe state is per-size, so an Option B probe cannot clobber the ADR-030 one. */
const STATE_FILE = path.resolve(__dirname, `../../../.fee-calibration-${POOL_TX_BYTES}.json`);
/** Descending: the first that is both accepted AND mined is the answer. */
const RATES = [0.15, 0.10, 0.05, 0.025, 0.01, 0.005, 0.001];

const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const unlock = () => new P2PKH().unlock(priv, 'all', false);
const log = (s: string) => console.log(s);

async function woc(p: string, attempts = 6): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`${WOC}${p}`, { cache: 'no-store' }); if (r.ok || r.status === 404) return r; } catch { /* retry */ }
    await sleep(2000 * (i + 1));
  }
  return null;
}

interface Probe { rate: number; fee: number; bytes: number; txid: string | null; accepted: boolean; error?: string }

/** OP_FALSE OP_RETURN <data> — provably unspendable, so the padding burns no satoshis. */
function padOutput(bytes: number): Script {
  const data = Buffer.alloc(Math.max(0, bytes), 0x2a);
  const parts: number[] = [0x00, 0x6a]; // OP_FALSE OP_RETURN
  if (data.length <= 0xff) parts.push(0x4c, data.length);
  else if (data.length <= 0xffff) { parts.push(0x4d, data.length & 0xff, (data.length >> 8) & 0xff); }
  else { parts.push(0x4e, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, (data.length >> 24) & 0xff); }
  return Script.fromHex(Buffer.concat([Buffer.from(parts), data]).toString('hex'));
}

async function probe() {
  log(`wallet: ${address}`);
  log(`probing ${RATES.length} fee rates with ${POOL_TX_BYTES}-byte transactions (real pool-spend size)\n`);

  const fees = RATES.map((r) => Math.ceil(POOL_TX_BYTES * r));
  const CHANGE = 1000; // each probe returns this much, so nothing is dust
  const need = fees.reduce((a, b) => a + b, 0) + fees.length * CHANGE;
  log(`total at risk if every probe is accepted: ${need.toLocaleString()} sats\n`);

  // pick a verified-unspent input (WoC lists spent outputs as unspent — see field notes)
  const uRes = await woc(`/address/${address}/unspent`);
  if (!uRes || !uRes.ok) throw new Error('could not fetch UTXOs');
  const utxos = (await uRes.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  const cands = utxos.filter((u) => u.value > need + 3000).sort((a, b) => b.value - a.value);
  let src: typeof cands[0] | undefined;
  for (const c of cands) {
    const sp = await woc(`/tx/${c.tx_hash}/${c.tx_pos}/spent`);
    if (sp && sp.status === 404) { src = c; break; }
  }
  if (!src) throw new Error(`no verified-unspent UTXO > ${need + 3000} sats`);
  const pRes = await woc(`/tx/${src.tx_hash}/hex`);
  const pHex = pRes && pRes.ok ? (await pRes.text()).trim() : null;
  if (!pHex) throw new Error('could not fetch parent');

  // one funding tx fans out an input per probe
  const funding = new Transaction();
  funding.addInput({ sourceTransaction: Transaction.fromHex(pHex), sourceOutputIndex: src.tx_pos, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  for (const f of fees) funding.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: f + CHANGE });
  funding.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
  await funding.fee();
  await funding.sign();
  const fundRaw = funding.toHex();
  const fundRes = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: fundRaw }) });
  const fundBody = (await fundRes.text()).trim();
  if (!fundRes.ok) throw new Error(`funding tx rejected: ${fundBody}`);
  log(`✓ funding tx ${fundBody.replace(/"/g, '').slice(0, 20)}…\n`);
  await sleep(5000);

  const probes: Probe[] = [];
  log('  rate (sat/B) │    fee │  bytes │ broadcast');
  log('  ─────────────┼────────┼────────┼──────────');
  for (let i = 0; i < RATES.length; i++) {
    const rate = RATES[i], fee = fees[i];
    // build once to measure, then pad to land on the target size
    let pad = POOL_TX_BYTES - 300;
    let tx = new Transaction();
    for (let attempt = 0; attempt < 4; attempt++) {
      tx = new Transaction();
      tx.addInput({ sourceTransaction: funding, sourceOutputIndex: i, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
      tx.addOutput({ lockingScript: padOutput(pad), satoshis: 0 });
      tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: CHANGE });
      await tx.sign();
      const size = tx.toHex().length / 2;
      if (Math.abs(size - POOL_TX_BYTES) <= 2) break;
      pad += POOL_TX_BYTES - size;
    }
    const raw = tx.toHex();
    const bytes = raw.length / 2;
    const actualRate = fee / bytes;

    let accepted = false, txid: string | null = null, error: string | undefined;
    try {
      const res = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: raw }) });
      const body = (await res.text()).trim();
      if (res.ok) { accepted = true; txid = body.replace(/"/g, ''); }
      else error = body.slice(0, 90);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }

    probes.push({ rate: actualRate, fee, bytes, txid, accepted, error });
    log(`  ${actualRate.toFixed(4).padStart(12)} │ ${String(fee).padStart(6)} │ ${String(bytes).padStart(6)} │ ` +
      (accepted ? `ACCEPTED ${txid!.slice(0, 16)}…` : `REJECTED ${error}`));
    await sleep(3000);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ at: 'probe', probes }, null, 2));
  const lowestAccepted = probes.filter((p) => p.accepted).sort((a, b) => a.rate - b.rate)[0];
  log(`\nLowest rate ACCEPTED into a mempool: ${lowestAccepted ? lowestAccepted.rate.toFixed(4) + ' sat/B' : 'none'}`);
  log('\n*** Acceptance is NOT the answer. Re-run with --check after a block or two to see');
  log('    which of these were actually MINED. An accepted-but-unmined tx would jam a pool. ***');
  log(`state saved to ${STATE_FILE}`);
}

async function check() {
  if (!fs.existsSync(STATE_FILE)) { console.error('no probe state — run --probe first'); process.exit(1); }
  const { probes } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { probes: Probe[] };
  log('Checking which probes were MINED (acceptance alone proves nothing)\n');
  log('  rate (sat/B) │    fee │ status');
  log('  ─────────────┼────────┼───────────────────────────');
  const mined: Probe[] = [];
  for (const p of probes) {
    if (!p.accepted || !p.txid) { log(`  ${p.rate.toFixed(4).padStart(12)} │ ${String(p.fee).padStart(6)} │ never accepted`); continue; }
    const r = await woc(`/tx/hash/${p.txid}`);
    let status = 'unknown';
    if (r && r.ok) {
      const t = (await r.json()) as { confirmations?: number; blockheight?: number };
      const conf = t.confirmations ?? 0;
      if (conf > 0) { status = `MINED (${conf} conf, block ${t.blockheight})`; mined.push(p); }
      else status = 'still unconfirmed — in mempool, not mined';
    } else if (r && r.status === 404) {
      status = 'GONE — dropped from the mempool';
    }
    log(`  ${p.rate.toFixed(4).padStart(12)} │ ${String(p.fee).padStart(6)} │ ${status}`);
    await sleep(1500);
  }

  const lowest = mined.sort((a, b) => a.rate - b.rate)[0];
  log('');
  if (lowest) {
    const roundTrip = Math.ceil(POOL_TX_BYTES * lowest.rate) * 2;
    const current = Math.ceil(POOL_TX_BYTES * 0.15) * 2;
    log(`Lowest rate actually MINED: ${lowest.rate.toFixed(4)} sat/B (${lowest.fee} sats for ${lowest.bytes} B)`);
    log(`  round trip at that rate : ${roundTrip.toLocaleString()} sats (today: ${current.toLocaleString()})`);
    log(`  improvement             : ${(current / roundTrip).toFixed(1)}x cheaper`);
    log(`  a 100,000-sat trade then pays ${((roundTrip / 100_000) * 100).toFixed(2)}% instead of ${((current / 100_000) * 100).toFixed(2)}%`);
    log('\nRecommend setting FEE_RATE with headroom ABOVE this, not at it — a rate that works');
    log('today can fail when mempools are busy, and a stuck pool tx blocks every successor.');
  } else {
    log('Nothing mined yet. Wait for another block and re-run --check.');
  }
}

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--probe') ? 'probe' : null;
if (!mode) { console.error('usage: --probe | --check'); process.exit(1); }
(mode === 'probe' ? probe() : check()).catch((e) => { console.error('❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
