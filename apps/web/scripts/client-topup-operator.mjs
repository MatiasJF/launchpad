// client-topup-operator.mjs — move a fee reserve from the CLIENT test wallet to the
// OPERATOR base address, so the operator can pay delivery/refund fees during two-party
// harness runs. Both keys are local (TEST_CLIENT_KEY + OPERATOR_KEY in gitignored .env);
// this spends the CLIENT's funds (the sats you funded for testing) — no new send needed.
//
// Run:  pnpm --filter @launchpad/web client:topup            # send 30000 sats (default)
//       pnpm --filter @launchpad/web client:topup -- 50000   # custom amount
//       pnpm --filter @launchpad/web client:topup -- 30000 dry
import fs from 'node:fs';
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk';

const CHAIN = 'main';
const WOC = `https://api.whatsonchain.com/v1/bsv/${CHAIN}`;
const FEE_RATE = 100; // sat/kb = 0.1 sat/byte
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2).filter((a) => a !== '--');
const AMOUNT = Math.max(2000, Number(args.find((a) => /^\d+$/.test(a)) ?? 30000) || 30000);
const DRY = args.includes('dry');

const ENV = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const clientHex = (ENV.match(/^TEST_CLIENT_KEY=(.+)$/m)?.[1] ?? '').trim();
const operatorHex = (ENV.match(/^OPERATOR_KEY=(.+)$/m)?.[1] ?? '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(clientHex)) { console.error('❌ TEST_CLIENT_KEY missing (run: pnpm test:client)'); process.exit(1); }
if (!/^[0-9a-fA-F]{64}$/.test(operatorHex)) { console.error('❌ OPERATOR_KEY missing'); process.exit(1); }

const client = PrivateKey.fromString(clientHex, 'hex');
const clientAddr = client.toPublicKey().toAddress();
const operatorAddr = PrivateKey.fromString(operatorHex, 'hex').toPublicKey().toAddress();
console.log(`client ${clientAddr} → operator ${operatorAddr} : ${AMOUNT} sats`);

async function wocJson(p) { for (let i = 0; i < 5; i++) { const r = await fetch(`${WOC}${p}`).catch(() => null); if (r && r.status === 429) { await sleep(2500); continue; } if (!r || !r.ok) return null; return r.json().catch(() => null); } return null; }
async function wocRaw(txid) { for (let i = 0; i < 5; i++) { const r = await fetch(`${WOC}/tx/${txid}/hex`).catch(() => null); if (r && r.status === 429) { await sleep(2500); continue; } if (!r || !r.ok) return null; return (await r.text()).trim(); } return null; }
async function isUnspent(txid, vout) { for (let i = 0; i < 3; i++) { const r = await fetch(`${WOC}/tx/${txid}/${vout}/spent`, { cache: 'no-store' }).catch(() => null); if (r && r.status === 404) return true; if (r && r.ok) return false; await sleep(800); } return null; }
async function wocPush(hex) { for (let i = 0; i < 6; i++) { const r = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }) }).catch((e) => ({ status: 0, ok: false, text: async () => String(e.message) })); const b = (await r.text()).trim().replace(/\s+/g, ' ').slice(0, 80); if (r.status === 429) { await sleep(3000); continue; } if (r.ok || /already|known/i.test(b)) return { ok: true, body: b }; return { ok: false, body: b }; } return { ok: false, body: 'rate-limited' }; }

const norm = (u) => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: Number(u.value) });
const conf = (await wocJson(`/address/${clientAddr}/confirmed/unspent`))?.result ?? [];
const unconf = (await wocJson(`/address/${clientAddr}/unconfirmed/unspent`))?.result ?? [];
const all = [...(Array.isArray(conf) ? conf : []), ...(Array.isArray(unconf) ? unconf : [])].map(norm).sort((a, b) => b.satoshis - a.satoshis);

const inputs = [];
let total = 0;
for (const u of all) {
  if (total >= AMOUNT + 500) break;
  const un = await isUnspent(u.txid, u.vout); await sleep(150);
  if (un === false) continue;
  inputs.push(u); total += u.satoshis;
}
if (total < AMOUNT + 500) { console.error(`❌ client has only ${total} spendable sats, need ${AMOUNT} + fee`); process.exit(1); }

const tx = new Transaction();
for (const u of inputs) {
  const raw = await wocRaw(u.txid); await sleep(150);
  if (!raw) { console.error(`❌ could not fetch source raw for ${u.txid}`); process.exit(1); }
  tx.addInput({ sourceTransaction: Transaction.fromHex(raw), sourceOutputIndex: u.vout, unlockingScriptTemplate: new P2PKH().unlock(client) });
}
tx.addOutput({ lockingScript: new P2PKH().lock(operatorAddr), satoshis: AMOUNT });
tx.addOutput({ lockingScript: new P2PKH().lock(clientAddr), change: true });
await tx.fee(new SatoshisPerKilobyte(FEE_RATE));
await tx.sign();
const rawHex = tx.toHex();
const txid = tx.id('hex');
console.log(`built ${txid} (${rawHex.length / 2} bytes): ${AMOUNT} → operator, change → client`);
if (DRY) { console.log('RAW:', rawHex); console.log('(dry — not broadcast)'); process.exit(0); }
const r = await wocPush(rawHex);
console.log(r.ok ? `✅ broadcast ${txid} — operator funded with ${AMOUNT} sats` : `✗ WoC rejected: ${r.body}`);
process.exit(r.ok ? 0 : 1);
