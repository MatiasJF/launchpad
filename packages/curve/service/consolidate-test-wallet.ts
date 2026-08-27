/**
 * consolidate-test-wallet.ts — sweep the test CLIENT wallet's UTXOs into one.
 *
 * The mainnet harnesses fund a whole run from a SINGLE input (the deploy tx fans it out into the
 * per-step funding outputs), so a wallet holding the same total spread across a dozen leftovers
 * fails with "no verified-unspent UTXO > N" even though the balance is ample. This sweeps them
 * back together. Each candidate is verified against `/spent` first, because WhatsOnChain lists
 * already-spent outputs as unspent and a stale one poisons the whole tx (`txn-mempool-conflict`).
 *
 *   node service/dist/service/consolidate-test-wallet.js --dry
 *   node service/dist/service/consolidate-test-wallet.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey } from '@bsv/sdk';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const DRY = process.argv.includes('--dry');
const FEE_RATE = 0.15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();

async function woc(p: string, attempts = 6): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`${WOC}${p}`, { cache: 'no-store' }); if (r.ok || r.status === 404) return r; } catch { /* retry */ }
    await sleep(2000 * (i + 1));
  }
  return null;
}

async function main() {
  console.log(`test client wallet: ${address}`);
  const res = await woc(`/address/${address}/unspent`);
  if (!res || !res.ok) throw new Error('could not fetch UTXOs');
  const all = (await res.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  all.sort((a, b) => b.value - a.value);

  const live: typeof all = [];
  for (const u of all) {
    const sp = await woc(`/tx/${u.tx_hash}/${u.tx_pos}/spent`);
    if (sp && sp.status === 404) live.push(u);
    else console.log(`  skip ${u.tx_hash.slice(0, 12)}…:${u.tx_pos} (${u.value}) — already spent`);
  }
  if (live.length < 2) { console.log('nothing to consolidate'); return; }

  const total = live.reduce((s, u) => s + u.value, 0);
  console.log(`\n${live.length} verified-unspent UTXOs, ${total} sats total`);

  const tx = new Transaction();
  for (const u of live) {
    const hexRes = await woc(`/tx/${u.tx_hash}/hex`);
    if (!hexRes || !hexRes.ok) throw new Error(`could not fetch parent ${u.tx_hash.slice(0, 12)}…`);
    const parent = Transaction.fromHex((await hexRes.text()).trim());
    tx.addInput({ sourceTransaction: parent, sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false), sequence: 0xffffffff });
  }
  const estSize = live.length * 148 + 40;
  const fee = Math.ceil(estSize * FEE_RATE);
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: total - fee });
  await tx.sign();
  const raw = tx.toHex();
  console.log(`consolidating into 1 output of ${total - fee} sats (${raw.length / 2} B, fee ${fee})`);

  if (DRY) { console.log('(dry) not broadcast'); return; }
  const b = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: raw }) });
  const body = (await b.text()).trim();
  if (!b.ok) throw new Error(`broadcast rejected: ${body}`);
  console.log(`✓ ${body.replace(/"/g, '')}`);
}

main().catch((e) => { console.error('❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
