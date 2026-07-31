// Diagnose + clean a corrupted local wallet: it has a DEAD chain of unconfirmed txs
// (can never confirm) that it keeps building new sends on. This lists every action with
// its status, checks each txid against the chain (WhatsOnChain), aborts the ones that are
// NOT on-chain (freeing their reserved inputs), and reports the spendable-output picture so
// we can see whether genuinely-confirmed coins are available to respend.
//
// Read-only unless you pass `abort`:   node scripts/wallet-clean.mjs         (inspect only)
//                                      node scripts/wallet-clean.mjs abort   (also abort dead actions)
import { WalletClient } from '@bsv/sdk';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const DO_ABORT = process.argv.includes('abort');
const CHAIN = 'main';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w = new WalletClient('secure-json-api', 'deggen.com');
try { await w.isAuthenticated({}); await w.getVersion(); } catch (e) { console.error('❌ wallet unreachable:', e.message); process.exit(1); }

// --- actions ---
const { actions = [], totalActions } = await w.listActions({ labels: [], limit: 1000 }).catch(() => ({ actions: [] }));
const byStatus = {};
for (const a of actions) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
console.log(`\n=== ${totalActions ?? actions.length} actions — by status ===`);
console.log(byStatus);

// which action txids are actually on-chain?
const txids = [...new Set(actions.map((a) => a.txid).filter(Boolean))];
const onchain = new Set();
for (let i = 0; i < txids.length; i += 20) {
  const batch = txids.slice(i, i + 20);
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${CHAIN}/txs/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txids: batch }),
  }).then((r) => r.json()).catch(() => []);
  for (const r of res ?? []) if (r.confirmations > 0 || r.blockheight) onchain.add(r.txid);
  await sleep(500);
}
const dead = actions.filter((a) => a.txid && !onchain.has(a.txid));
console.log(`\non-chain: ${onchain.size} · not-on-chain (dead): ${dead.length}`);
console.log('dead statuses:', [...new Set(dead.map((a) => a.status))]);

// --- outputs (what can we actually spend?) ---
const { outputs = [], totalOutputs } = await w.listOutputs({ basket: 'default', limit: 1000 }).catch(() => ({ outputs: [] }));
const spendable = outputs.filter((o) => o.spendable);
const sats = spendable.reduce((s, o) => s + Number(o.satoshis ?? 0), 0);
const fromConfirmed = spendable.filter((o) => onchain.has((o.outpoint ?? '').split('.')[0]));
const cleanSats = fromConfirmed.reduce((s, o) => s + Number(o.satoshis ?? 0), 0);
console.log(`\n=== ${totalOutputs ?? outputs.length} outputs · ${spendable.length} spendable = ${sats} sats ===`);
console.log(`  of which sit on CONFIRMED txs (clean to respend): ${fromConfirmed.length} = ${cleanSats} sats`);

// --- abort dead actions ---
if (DO_ABORT) {
  console.log(`\n=== aborting ${dead.length} dead action(s) ===`);
  let ok = 0;
  for (const a of dead) {
    try { await w.abortAction({ reference: a.reference }); ok++; console.log(`  ✓ aborted ${a.txid} (${a.status})`); }
    catch (e) { console.log(`  ✗ ${a.txid} (${a.status}): ${e.message}`); }
    await sleep(150);
  }
  console.log(`aborted ${ok}/${dead.length}. Re-run operator:fund afterwards.`);
} else {
  console.log('\n(inspect only — re-run with `abort` to clear the dead actions)');
}
process.exit(0);
