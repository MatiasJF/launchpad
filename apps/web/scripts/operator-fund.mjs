// Operator funding that BYPASSES a broken local broadcaster.
//
// BSV Desktop can SIGN but isn't broadcasting (txs never reach the network). So this:
//   1. connects to the local wallet (holds your sats) + aborts stuck actions (frees UTXOs),
//   2. builds + signs a funding payment to the operator (same BRC-42 derivation fund-metanet uses),
//   3. extracts the SIGNED raw tx and does NOT rely on the local broadcaster,
//   4. prints the raw tx hex (so it can be pushed via WhatsOnChain), and
//   5. internalizes it into the operator's wallet-toolbox wallet (same identity operator:balance reads).
//
// Run:  pnpm --filter @launchpad/web operator:fund -- 10000     (satoshis; default 10000)
// Then the raw hex is broadcast via WoC; confirm with operator:balance.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WalletClient, PrivateKey, PublicKey, P2PKH, Transaction, KeyDeriver } from '@bsv/sdk';
import { Wallet, WalletStorageManager, WalletSigner, Services, StorageClient } from '@bsv/wallet-toolbox';

const CHAIN = 'main';
const STORAGE_URL = 'https://store-us-1.bsvb.tech';
const PROTOCOL = [2, '3241645161d8'];
const numArg = process.argv.slice(2).find((a) => /^\d+$/.test(a)); // tolerate `-- 10000`
const amount = Number(numArg ?? process.env.FUND_SATS ?? 10000);

// --- operator key (destination) from .env, never printed ---
const ENV_PATH = new URL('../.env', import.meta.url);
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^OPERATOR_KEY=(.+)$/m)?.[1] ?? '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) { console.error('❌ OPERATOR_KEY missing/!hex'); process.exit(1); }
const operatorPub = new PrivateKey(keyHex, 'hex').toPublicKey().toString();

// --- build the operator's toolbox wallet (destination custody) ---
const kd = new KeyDeriver(new PrivateKey(keyHex, 'hex'));
const sm = new WalletStorageManager(kd.identityKey);
const opWallet = new Wallet(new WalletSigner(CHAIN, kd, sm), new Services(CHAIN));
const opStore = new StorageClient(opWallet, STORAGE_URL);
await opStore.makeAvailable(); await sm.addWalletStorageProvider(opStore);
console.log('operator identity:', kd.identityKey);

// --- connect the LOCAL wallet (your funds) — same substrate fund-metanet uses ---
const local = new WalletClient('secure-json-api', 'deggen.com');
try {
  await local.isAuthenticated({});
  const { version } = await local.getVersion();
  console.log('local wallet version:', version);
} catch (e) { console.error('❌ Local BSV/Metanet Desktop not reachable:', e.message); process.exit(1); }

// 1) free stuck UTXOs
const { actions = [] } = await local.listActions({ labels: [], limit: 100 }).catch(() => ({ actions: [] }));
const stuck = actions.filter((a) => ['unsigned', 'unprocessed', 'sending', 'nosend'].includes(a.status));
for (const a of stuck) { try { await local.abortAction({ reference: a.reference }); console.log('aborted stuck action', a.txid ?? a.reference); } catch {} }

// 2) build the funding output (BRC-42 derived toward the operator)
const derivationPrefix = randomBytes(10).toString('base64');
const derivationSuffix = randomBytes(10).toString('base64');
const { publicKey: payer } = await local.getPublicKey({ identityKey: true });
const { publicKey: derived } = await local.getPublicKey({ counterparty: operatorPub, protocolID: PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}` });
const lockingScript = new P2PKH().lock(PublicKey.fromString(derived).toAddress()).toHex();

// 3) sign WITHOUT depending on the local broadcaster
const action = await local.createAction({
  description: 'Fund operator wallet',
  outputs: [{ lockingScript, satoshis: amount, outputDescription: 'operator funding',
    customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee: operatorPub }) }],
  options: { randomizeOutputs: false, noSend: true },
});
if (!action.tx) { console.error('❌ No signed tx returned (wallet could not sign).', action); process.exit(1); }
const rawHex = Transaction.fromAtomicBEEF(action.tx).toHex();
console.log('\ntxid       :', action.txid);
console.log('RAW TX HEX :', rawHex);

// 4) push via WhatsOnChain — the funding tx spends UNCONFIRMED ancestors (your wallet's
//    un-broadcast chain), so push every unconfirmed ancestor first (BEEF has them all),
//    parents-first, then the funding tx. WoC's single-tx endpoint needs each parent present.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wocPush(hex) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${CHAIN}/tx/raw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }),
    }).catch((e) => ({ status: 0, ok: false, text: async () => String(e.message) }));
    const body = (await res.text()).trim().replace(/\s+/g, ' ').slice(0, 70);
    if (res.status === 429) { await sleep(3000); continue; }         // rate-limited -> back off + retry
    if (res.ok || /already|known/i.test(body)) return { done: true, status: res.status, body };
    return { done: false, status: res.status, body };                 // real reject (e.g. Missing inputs)
  }
  return { done: false, status: 429, body: 'rate-limited (gave up)' };
}
function collectUnconfirmed(tx, out, seen) {
  for (const inp of tx.inputs) {
    const src = inp.sourceTransaction;
    if (!src || src.merklePath) continue; // undefined or confirmed boundary -> stop
    collectUnconfirmed(src, out, seen);   // parents before child
    const id = src.id('hex');
    if (!seen.has(id)) { seen.add(id); out.push(src); }
  }
  return out;
}
const rootTx = Transaction.fromAtomicBEEF(action.tx);
const chain = collectUnconfirmed(rootTx, [], new Set());
let pending = [...chain, rootTx].map((t) => ({ hex: t.toHex(), id: t.id('hex') }));
console.log(`\nflushing ${pending.length} unconfirmed tx(s) via WoC (throttled, multi-pass):`);
for (let pass = 1; pending.length; pass++) {
  const next = [];
  let progressed = false;
  console.log(`\n  pass ${pass} — ${pending.length} pending`);
  for (const t of pending) {
    const r = await wocPush(t.hex);
    console.log(`    ${r.done ? '✓' : '✗'} ${t.id} -> ${r.status} ${r.body}`);
    if (r.done) progressed = true; else next.push(t);
    await sleep(450); // ~2 req/s, under WoC's free-tier limit
  }
  pending = next;
  if (!progressed) { console.log('\n  ⚠️  a full pass landed nothing new — stopping'); break; }
}
console.log(pending.length ? `\n⚠️  ${pending.length} tx(s) still unbroadcast` : '\n✅ entire chain broadcast — funding tx is live');

// 5) internalize into the operator wallet so it tracks the UTXO
try {
  const r = await opWallet.internalizeAction({
    tx: action.tx,
    outputs: [{ outputIndex: 0, protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: payer } }],
    description: 'Operator funding (internalized)',
  });
  console.log('internalized:', JSON.stringify(r));
} catch (e) { console.log('internalize error:', e.message); }

const { outputs = [] } = await opWallet.listOutputs({ basket: 'default', limit: 1000 }, 'fund');
console.log('operator balance (sats):', outputs.reduce((s, o) => s + Number(o.satoshis ?? 0), 0));
process.exit(0);
