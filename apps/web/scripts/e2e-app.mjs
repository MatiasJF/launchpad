/**
 * e2e-app.mjs — FULL-STACK, real-product mainnet round-trip.
 *
 * Unlike e2e-stas.mjs (which drives the covenant/packages DIRECTLY, no DB, no server
 * actions), this exercises the ACTUAL PRODUCT: the real Next.js `'use server'` actions +
 * the real Prisma database + the real chain — the exact code paths the app's buttons call.
 * It stubs ONLY Next's cache/routing/cookies (UI glue) via ./lib/stub-next.mjs so the
 * server actions can be imported into a plain tsx script; everything else is real.
 *
 * Two flat-key wallets (a real two-party test): the CLIENT (TEST_CLIENT_KEY) plays
 * project-owner/admin/buyer/seller; the OPERATOR (OPERATOR_KEY) co-signs delivery+refund
 * INSIDE the real server actions (deliverStasToBuyer / finalizeStasSell read OPERATOR_KEY).
 *
 * Lifecycle: create project -> approve -> set bonding_curve -> deploy pool -> mint ->
 *            buy -> operator deliver -> sell -> operator refund. Writes the real DB, so
 *            the project + orders SHOW UP in the running app afterward.
 *
 * Run:  pnpm --filter @launchpad/web e2e:app
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN = 'main';
const STAS_PROTOCOL = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.e2e.app';
const K = 1, SUPPLY = 3, SEED_RESERVE_SATS = 546, DELTA = 1;
const MIN_CLIENT_SATS = 2500, MIN_OPERATOR_SATS = 2500;

// ── env + Next-stub loader (must be before any server-action import) ──────────────
const loadEnv = (p) => { try { for (const line of fs.readFileSync(p, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch { /* ignore */ } };
loadEnv(path.join(__dirname, '..', '.env'));
loadEnv(path.join(__dirname, '..', '..', '..', 'packages', 'db', '.env'));
register('./lib/stub-next.mjs', import.meta.url);

// ── dynamic imports (after register + env) ────────────────────────────────────────
const { prisma } = await import('@launchpad/db');
const A = await import('../lib/actions.ts');
const S = await import('../lib/stas-actions.ts');
const { resolveCurrentPool, getOutputInfo, getSourceBeef, getSourceBeefDeep, broadcastRawTx, broadcastBeefChain, getOperatorBaseUtxos } = await import('../lib/settle-actions.ts');
const bsvjs = (await import('bsv')).default ?? (await import('bsv'));
const { buildStasBuyTx, curveCost } = await import('@launchpad/curve');
const { issueStasGenesis } = await import('@launchpad/bsv/genesis');
const { transferStas } = await import('@launchpad/bsv/settle');
const { PublicKey, Transaction, KeyDeriver, PrivateKey } = await import('@bsv/sdk');
const { FlatKeyWallet } = await import('./lib/flat-key-wallet.mjs');

// ── tiny reporter ─────────────────────────────────────────────────────────────────
const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (...a) => console.log(ts(), ...a);
const kv = (k, v) => console.log(`    ${k.padEnd(16)} ${v}`);
const hr = (c = '─') => console.log(c.repeat(80));
const wocTx = (id) => `https://whatsonchain.com/tx/${id}`;
class StepError extends Error {}
const fail = (msg, ctx) => { if (ctx) console.log('    ── ctx ──\n' + JSON.stringify(ctx, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2).slice(0, 1200)); return new StepError(msg); };
const results = [];
async function step(name, fn) {
  log(`▶ STEP: ${name}`); hr();
  try { await fn(); results.push([true, name]); log(`✅ OK: ${name}`); }
  catch (e) { results.push([false, name, e.message]); log(`❌ FAIL: ${name}`); kv('ERROR', e.message); throw e; }
}
async function broadcastWithParent(parentRaw, parentTxid, rawTx, id, label) {
  if (parentRaw) { const pb = await broadcastRawTx(parentRaw, parentTxid); log(`  ${label} · parent:`, pb.ok ? `ok` : `(${pb.error})`); }
  let bc = await broadcastRawTx(rawTx, id);
  for (let i = 0; i < 6 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
    log(`  ${label} · child missing inputs, retry ${i + 1}/6…`); await new Promise((r) => setTimeout(r, 2500));
    if (parentRaw) await broadcastRawTx(parentRaw, parentTxid); bc = await broadcastRawTx(rawTx, id);
  }
  return bc;
}
const rawFromCreateAction = (res) => { try { return Transaction.fromAtomicBEEF(res.tx).toHex(); } catch { return ''; } };
async function baseBalance(address) { try { const u = await getOperatorBaseUtxos(address); return u.reduce((s, x) => s + Number(x.satoshis ?? 0), 0); } catch { return 0; } }

const pkhOf = (pubHex) => bsvjs.crypto.Hash.sha256ripemd160(bsvjs.PublicKey.fromString(pubHex).toBuffer()).toString('hex');

async function main() {
  hr('█'); log('FULL-STACK real-product mainnet E2E (real server actions + real DB + chain)'); hr('█');
  const opHex = process.env.OPERATOR_KEY, clientHex = process.env.TEST_CLIENT_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(opHex || '')) throw new Error('OPERATOR_KEY missing in apps/web/.env');
  if (!/^[0-9a-fA-F]{64}$/.test(clientHex || '')) throw new Error('TEST_CLIENT_KEY missing — run: pnpm --filter @launchpad/web test:client');

  const opPub = PrivateKey.fromString(opHex, 'hex').toPublicKey();
  const op = { pubHex: opPub.toString(), address: opPub.toAddress() };
  const clientPriv = PrivateKey.fromString(clientHex, 'hex');
  const clientPub = clientPriv.toPublicKey();
  const client = { pubHex: clientPub.toString(), address: clientPub.toAddress() };
  const clientWallet = new FlatKeyWallet(clientHex, {
    chain: CHAIN, basePkh: pkhOf(client.pubHex),
    baseAddress: client.address, operatorPubHex: client.pubHex,
    fetchUtxos: () => getOperatorBaseUtxos(client.address), fetchBeef: getSourceBeefDeep,
    broadcastChain: broadcastBeefChain,
  });
  const clientIdentityKey = new KeyDeriver(clientPriv).identityKey;
  const { publicKey: identity } = await clientWallet.getPublicKey({ identityKey: true }, ORIGINATOR);

  const clientBal = await baseBalance(client.address), opBal = await baseBalance(op.address);
  kv('client addr', `${client.address}  (owner/admin/buyer/seller)`);
  kv('client sats', `${clientBal}`);
  kv('operator addr', `${op.address}  (delivery/refund co-sign)`);
  kv('operator sats', `${opBal}`);
  kv('client identity', `${identity.slice(0, 20)}…`);
  if (clientBal < MIN_CLIENT_SATS) throw new Error(`client base ${clientBal} < ${MIN_CLIENT_SATS} — fund ${client.address}`);
  if (opBal < MIN_OPERATOR_SATS) throw new Error(`operator base ${opBal} < ${MIN_OPERATOR_SATS} — run: pnpm --filter @launchpad/web client:topup`);

  const state = {};

  // 1 ── CREATE PROJECT (real createProject server action) ───────────────────────────
  await step('CREATE PROJECT (real createProject server action + DB)', async () => {
    const stamp = Date.now();
    const name = `E2E App ${stamp}`, ticker = `$EA${String(stamp).slice(-5)}`;
    const fd = new FormData();
    fd.set('name', name); fd.set('ticker', ticker); fd.set('identityPubkey', identity);
    fd.set('payoutAddress', client.address); fd.set('totalSupply', '1000');
    fd.set('priceSats', '1'); fd.set('publicAllocation', '1000');
    let redirected = '';
    try { await A.createProject(fd); } catch (e) { redirected = e?.digest || e?.message || ''; }
    if (!/ok=1/.test(redirected)) throw fail(`createProject did not succeed (redirect: ${redirected})`, {});
    const project = await prisma.project.findFirst({ where: { owner: { identityPubkey: identity } }, orderBy: { createdAt: 'desc' }, include: { tokens: { include: { sales: true } } } });
    if (!project) throw fail('project row not found after createProject', {});
    state.project = project; state.slug = project.slug;
    state.token = project.tokens[0]; state.sale = project.tokens[0].sales[0];
    kv('project', `${project.name}  slug=${project.slug}  status=${project.status}`);
    kv('token/sale', `${state.token.ticker}  saleId=${state.sale.id}  type=${state.sale.type}`);
  });

  // 2 ── APPROVE (admin) + SET BONDING CURVE (owner) — real actions ───────────────────
  await step('APPROVE + set bonding_curve (real setProjectStatus + updateSaleEscrow)', async () => {
    const fd = new FormData(); fd.set('id', state.project.id); fd.set('status', 'live');
    await A.setProjectStatus(fd); // admin (cookie stub → isAdmin true)
    const esc = await A.updateSaleEscrow({ projectId: state.project.id, identityPubkey: identity, type: 'bonding_curve', softCapSats: 0, hardCapSats: 0, pledgeUnitSats: 0 });
    if (!esc.ok) throw fail(`updateSaleEscrow failed: ${esc.error}`, {});
    const p = await prisma.project.findUnique({ where: { id: state.project.id } });
    const sale = await prisma.sale.findUnique({ where: { id: state.sale.id } });
    kv('project status', p.status); kv('sale type', sale.type);
    if (sale.type !== 'bonding_curve') throw fail('sale.type did not become bonding_curve', {});
  });

  // 3 ── DEPLOY POOL (real createStasPool → client signs seed → real markStasPoolDeployed)
  await step('DEPLOY reserve covenant (real createStasPool + client wallet + markStasPoolDeployed)', async () => {
    const cp = await S.createStasPool({ saleId: state.sale.id, identityPubkey: identity, seedReserveSats: SEED_RESERVE_SATS, k: K, supply: SUPPLY });
    if (!cp.ok) throw fail(`createStasPool failed: ${cp.error}`, {});
    const covenantHex = cp.scriptHex;
    kv('covenant bytes', covenantHex.length / 2);
    const res = await clientWallet.createAction({ description: 'e2e-app pool deploy', outputs: [{ lockingScript: covenantHex, satoshis: SEED_RESERVE_SATS, outputDescription: 'stas curve pool reserve' }], options: { randomizeOutputs: false } }, ORIGINATOR);
    if (!res?.txid) throw fail('deploy createAction returned no txid', {});
    const rawTx = rawFromCreateAction(res);
    let poolVout = 0; try { poolVout = Transaction.fromHex(rawTx).outputs.findIndex((o) => o.lockingScript.toHex().toLowerCase() === covenantHex.toLowerCase()); if (poolVout < 0) poolVout = 0; } catch { /* 0 */ }
    const bc = await broadcastRawTx(rawTx, res.txid);
    if (!bc.ok) throw fail(`deploy broadcast rejected: ${bc.error}`, {});
    const txid = bc.txid || res.txid;
    const md = await S.markStasPoolDeployed({ saleId: state.sale.id, identityPubkey: identity, txid, vout: poolVout, scriptHex: covenantHex, reserveSats: SEED_RESERVE_SATS });
    if (!md.ok) throw fail(`markStasPoolDeployed failed: ${md.error}`, {});
    kv('pool outpoint', `${txid}:${poolVout}`); kv('tx', wocTx(txid));
  });

  // 4 ── MINT (real prepareStasMint → client issueStasGenesis → real recordStasMint) ──
  await step('MINT supply to operator vault (real prepareStasMint + issueStasGenesis + recordStasMint)', async () => {
    const { publicKey: redemptionPubkey } = await clientWallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: `${state.slug}-redeem`, counterparty: 'self' }, ORIGINATOR);
    const plan = await S.prepareStasMint({ saleId: state.sale.id, identityPubkey: identity, redemptionPubkey });
    if (!plan.ok) throw fail(`prepareStasMint failed: ${plan.error}`, {});
    const g = await issueStasGenesis(clientWallet, clientIdentityKey, CHAIN, { slug: state.slug, symbol: plan.symbol, supply: Number(SUPPLY), ownerPubHex: plan.ownerPubHex });
    if (!g.ok) throw fail(`issueStasGenesis failed: ${g.reason}`, {});
    const cbc = await broadcastRawTx(g.contractRawTx, g.contractTxid);
    if (!cbc.ok) throw fail(`contract broadcast rejected: ${cbc.error}`, {});
    let ibc = await broadcastRawTx(g.issueRawTx, g.genesisTxid);
    for (let i = 0; i < 6 && !ibc.ok && /missing inputs/i.test(ibc.error ?? ''); i++) { await new Promise((r) => setTimeout(r, 2500)); await broadcastRawTx(g.contractRawTx, g.contractTxid); ibc = await broadcastRawTx(g.issueRawTx, g.genesisTxid); }
    if (!ibc.ok) throw fail(`issue broadcast rejected: ${ibc.error}`, {});
    state.issuanceTxid = ibc.txid || g.genesisTxid;
    const rec = await S.recordStasMint({ saleId: state.sale.id, identityPubkey: identity, issuanceTxid: state.issuanceTxid, tokenId: g.tokenId });
    if (!rec.ok) throw fail(`recordStasMint failed: ${rec.error}`, {});
    kv('issuanceTxid', state.issuanceTxid); kv('tokenId', g.tokenId); kv('tx', wocTx(state.issuanceTxid));
  });

  // 5 ── BUY (real prepareStasBuy → client buildStasBuyTx → real recordStasBuy → deliver)
  await step('BUY + operator DELIVER (real prepareStasBuy/recordStasBuy/deliverStasToBuyer)', async () => {
    const { publicKey: ownerPub2 } = await clientWallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: state.slug, counterparty: 'self' }, ORIGINATOR);
    const receiveAddress = PublicKey.fromString(ownerPub2).toAddress();
    state.receiveAddress = receiveAddress;
    const prep = await S.prepareStasBuy({ saleId: state.sale.id, buyerIdentity: identity, delta: DELTA });
    if (!prep.ok) throw fail(`prepareStasBuy failed: ${prep.error}`, {});
    kv('curve cost', `${prep.cost} sats`);
    const built = await buildStasBuyTx({ wallet: clientWallet, chain: CHAIN, pool: prep.pool, delta: DELTA });
    if (!built.ok) throw fail(`buildStasBuyTx failed: ${built.reason}`, {});
    kv('TX-A txid', built.txid);
    const bc = await broadcastWithParent(built.paymentRawTx, built.paymentTxid, built.rawTx, built.txid, 'BUY');
    if (!bc.ok) throw fail(`buy broadcast rejected: ${bc.error}`, {});
    const recBuy = await S.recordStasBuy({ saleId: state.sale.id, buyerIdentity: identity, receiveAddress, spentPoolTxid: prep.pool.txid, spentPoolVout: prep.pool.vout, buyTxid: bc.txid || built.txid, newPool: built.newPool, delta: DELTA, cost: prep.cost });
    if (!recBuy.ok) throw fail(`recordStasBuy failed: ${recBuy.error}`, {});
    state.buyOrderId = recBuy.orderId;
    kv('order', `${recBuy.orderId} (pending delivery)`);
    log('operator DELIVER (real deliverStasToBuyer — operator key inside the server action)…');
    const del = await S.deliverStasToBuyer({ orderId: recBuy.orderId });
    if (!del.ok) throw fail(`deliverStasToBuyer failed: ${del.error}`, {});
    state.deliveryTxid = del.txid;
    kv('delivered', del.txid); kv('tx', wocTx(del.txid));
  });

  // 6 ── SELL (real prepareStasSell → client transferStas → recordStasSell → finalize) ─
  await step('SELL + operator REFUND (real prepareStasSell/recordStasSell/finalizeStasSell)', async () => {
    const prep = await S.prepareStasSell({ saleId: state.sale.id, sellerIdentity: identity, delta: DELTA, sellerRefundAddress: client.address });
    if (!prep.ok) throw fail(`prepareStasSell failed: ${prep.error}`, {});
    const vaultAddress = prep.vaultAddress;
    kv('vault addr', vaultAddress); kv('curve refund', `${prep.refund} sats`);
    const cur = await resolveCurrentPool(state.deliveryTxid);
    if ('error' in cur) throw fail(`resolve delivered STAS failed: ${cur.error}`, {});
    const info = await getOutputInfo(cur.txid, cur.vout);
    if (!info) throw fail('could not fetch delivered STAS', {});
    let beef = await getSourceBeef(cur.txid); if (!beef) beef = await getSourceBeefDeep(cur.txid);
    if (!beef) throw fail('could not build ancestry BEEF for the return source', {});
    const ret = await transferStas(clientWallet, clientIdentityKey, CHAIN, {
      source: { txid: cur.txid, vout: cur.vout, scriptHex: info.scriptHex, satoshis: info.satoshis, brc42KeyId: state.slug, owner: { protocolID: STAS_PROTOCOL, keyID: state.slug, counterparty: 'self', forSelf: false }, beef },
      recipientAddress: vaultAddress, amount: DELTA, senderChangeHash160: info.scriptHex.substring(6, 46),
    });
    if (!ret.ok) throw fail(`transferStas (return) failed: ${ret.reason}`, {});
    const bc = await broadcastWithParent(ret.fundingRawTx, ret.fundingTxid, ret.rawTx, ret.txid, 'RETURN');
    if (!bc.ok) throw fail(`STAS return broadcast rejected: ${bc.error}`, {});
    state.returnTxid = bc.txid || ret.txid;
    kv('TX1 return', state.returnTxid);
    const recSell = await S.recordStasSell({ saleId: state.sale.id, sellerIdentity: identity, sellerRefundAddress: client.address, returnTxid: state.returnTxid, delta: DELTA });
    if (!recSell.ok) throw fail(`recordStasSell failed: ${recSell.error}`, {});
    log('operator REFUND (real finalizeStasSell — back-to-genesis + TX2 co-sign inside the action)…');
    const fin = await S.finalizeStasSell({ orderId: recSell.orderId });
    if (!fin.ok) throw fail(`finalizeStasSell failed: ${fin.error}`, {});
    state.refundTxid = fin.txid;
    kv('refunded', fin.txid); kv('tx', wocTx(fin.txid));
  });

  // 7 ── BUY #2 but DO NOT deliver — seed a real stuck paid-but-undelivered order ─────
  await step('BUY #2 (record, NO delivery) — seed a stuck delivery for the sweep', async () => {
    const prep = await S.prepareStasBuy({ saleId: state.sale.id, buyerIdentity: identity, delta: DELTA });
    if (!prep.ok) throw fail(`prepareStasBuy(2) failed: ${prep.error}`, {});
    const built = await buildStasBuyTx({ wallet: clientWallet, chain: CHAIN, pool: prep.pool, delta: DELTA });
    if (!built.ok) throw fail(`buildStasBuyTx(2) failed: ${built.reason}`, {});
    kv('TX-A #2', built.txid);
    const bc = await broadcastWithParent(built.paymentRawTx, built.paymentTxid, built.rawTx, built.txid, 'BUY2');
    if (!bc.ok) throw fail(`buy2 broadcast rejected: ${bc.error}`, {});
    const rec = await S.recordStasBuy({ saleId: state.sale.id, buyerIdentity: identity, receiveAddress: state.receiveAddress, spentPoolTxid: prep.pool.txid, spentPoolVout: prep.pool.vout, buyTxid: bc.txid || built.txid, newPool: built.newPool, delta: DELTA, cost: prep.cost });
    if (!rec.ok) throw fail(`recordStasBuy(2) failed: ${rec.error}`, {});
    state.stuckOrderId = rec.orderId;
    kv('stuck order', `${rec.orderId} (paid, deliberately NOT delivered)`);
  });

  // 8 ── AUTO-SWEEP the stuck delivery — delivery-robustness piece 1, on real DB+chain ─
  await step('AUTO-SWEEP stuck deliveries (real sweepPendingStasDeliveries)', async () => {
    const pend = await S.getPendingStasDeliveries(state.sale.id, identity);
    if (!pend.ok) throw fail(`getPendingStasDeliveries failed: ${pend.error}`, {});
    const found = pend.orders.some((o) => o.orderId === state.stuckOrderId);
    kv('pending found', `${pend.orders.length} stuck (our order present: ${found})`);
    if (!found) throw fail('stuck order not listed as pending — the sweep would miss it', {});
    log('sweeping (real sweepPendingStasDeliveries → idempotent deliverStasToBuyer per order)…');
    const sw = await S.sweepPendingStasDeliveries({ saleId: state.sale.id });
    if (!sw.ok) throw fail(`sweep failed: ${sw.error}`, {});
    kv('sweep result', `swept ${sw.swept}, delivered ${sw.delivered.length}, failed ${sw.failed.length}`);
    const mine = sw.delivered.find((d) => d.orderId === state.stuckOrderId);
    if (!mine) throw fail(`sweep did not deliver our stuck order (failed: ${JSON.stringify(sw.failed).slice(0, 240)})`, {});
    const o = await prisma.order.findUnique({ where: { id: state.stuckOrderId } });
    if (o.state !== 'settled' || !o.txid) throw fail(`order not settled after sweep (state=${o.state}, txid=${o.txid})`, {});
    state.sweepDeliveryTxid = mine.txid;
    kv('sweep delivered', `${mine.txid} — DB order now settled ✓`);
    kv('tx', wocTx(mine.txid));
  });

  return { state, client, op };
}

let out = null, fatal = null;
try { out = await main(); } catch (e) { fatal = e; }
hr('█'); log('SUMMARY'); hr('█');
for (const [ok, name, err] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}${err ? '  — ' + err : ''}`);
if (out) {
  const { state, client, op } = out;
  console.log('\n  txids:');
  for (const k of ['issuanceTxid', 'deliveryTxid', 'returnTxid', 'refundTxid', 'sweepDeliveryTxid']) if (state[k]) console.log(`    ${k.padEnd(18)} ${wocTx(state[k])}`);
  console.log(`\n  ▶ OPEN IN THE APP: run \`pnpm --filter @launchpad/web dev\` and visit  /sale/${state.slug}`);
  console.log(`  client end sats: ${await baseBalance(client.address)} | operator end sats: ${await baseBalance(op.address)}`);
}
console.log(fatal ? `\n  RESULT: ❌ FAILED — ${fatal.message}\n` : `\n  RESULT: ✅ PASS — full real-product lifecycle landed on mainnet (real server actions + real DB)\n`);
await prisma.$disconnect().catch(() => {});
process.exit(fatal ? 1 : 0);
