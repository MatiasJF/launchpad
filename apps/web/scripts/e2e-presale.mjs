/**
 * e2e-presale.mjs — FULL-STACK mainnet round-trip for the ADR-025 escrow presale.
 *
 * The crowdfunding path has been "built, live-test pending" since 2026-07-29. This
 * proves it on mainnet against the REAL server actions + REAL Prisma DB + REAL chain,
 * the same way e2e-app.mjs proves the curve. It stubs only Next's cache/routing glue.
 *
 * What it establishes that a typecheck cannot:
 *   • a 0xC1 pledge signed ALONE still verifies once other inputs join the assurance tx
 *   • the contributor can independently spend their own pledge UTXO (the trustless
 *     refund) — and the presale correctly recovers from that withdrawal
 *   • the assurance tx pays a fee a MINER accepts, measured from the bytes WoC returns,
 *     with NO change output to absorb an estimate error (every pledge signed SIGHASH_ALL
 *     over the output set, so the outputs are frozen — this is the sharpest failure mode)
 *   • funded pledges become settle-eligible Orders and the tokens actually arrive
 *
 * Every broadcast is appended to docs/mainnet-runs/presale-<stamp>.jsonl so the proof
 * outlives the scrollback (LESSONS.md, 2026-08-28).
 *
 * Run:  pnpm --filter @launchpad/web e2e:presale
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN = 'main';
const STAS_PROTOCOL = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.e2e.presale';

// Presale shape. softCap/hardCap MUST be exact multiples of the pledge unit
// (updateSaleEscrow enforces it), and the unit must divide by priceSats or the
// contributor is silently short-changed by the floor in markAssemblyBroadcast.
const PLEDGE_UNIT = 1000;      // sats per pledge
const SOFT_CAP = 2000;         // = 2 pledges
const HARD_CAP = 3000;
const PRICE = 100;             // sats per token -> 10 tokens per pledge
const STAS_SUPPLY = 40;        // minted supply, must cover SOFT_CAP/PRICE = 20
const WITHDRAW_FEE = 30;       // sats burned reclaiming a pledge UTXO
const MIN_CLIENT_SATS = 12000, MIN_OPERATOR_SATS = 5000; // the operator pledges too now

// ── env + Next-stub loader (must be before any server-action import) ──────────────
const loadEnv = (p) => { try { for (const line of fs.readFileSync(p, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch { /* ignore */ } };
loadEnv(path.join(__dirname, '..', '.env'));
loadEnv(path.join(__dirname, '..', '..', '..', 'packages', 'db', '.env'));
register('./lib/stub-next.mjs', import.meta.url);

// ── dynamic imports (after register + env) ────────────────────────────────────────
const { prisma } = await import('@launchpad/db');
const A = await import('../lib/actions.ts');
const S = await import('../lib/stas-actions.ts');
const E = await import('../lib/escrow-actions.ts');
const O = await import('../lib/order-actions.ts');
const M = await import('../lib/mint.ts');
const { broadcastRawTx, broadcastBeefChain, getOperatorBaseUtxos, getSourceBeef, getSourceBeefDeep, getOutputInfo, resolveCurrentPool, isOutputUnspent } = await import('../lib/settle-actions.ts');
const bsvjs = (await import('bsv')).default ?? (await import('bsv'));
const { createPledge, assembleAssuranceTx, withdrawPledge, PLEDGE_BASKET } = await import('@launchpad/bsv/pledge');
const { issueStasGenesis } = await import('@launchpad/bsv/genesis');
const { batchTransferStas, MAX_BATCH_RECIPIENTS } = await import('@launchpad/bsv/settle');
const { signP2pkhInput } = await import('@launchpad/bsv/settle/p2pkh');
const { Transaction, KeyDeriver, PrivateKey, P2PKH } = await import('@bsv/sdk');
const { FlatKeyWallet } = await import('./lib/flat-key-wallet.mjs');

// ── reporter ──────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (...a) => console.log(ts(), ...a);
const kv = (k, v) => console.log(`    ${String(k).padEnd(18)} ${v}`);
const hr = (c = '─') => console.log(c.repeat(84));
const wocTx = (id) => `https://whatsonchain.com/tx/${id}`;
class StepError extends Error {}
const fail = (msg, ctx) => { if (ctx) console.log('    ── ctx ──\n' + JSON.stringify(ctx, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2).slice(0, 1200)); return new StepError(msg); };
const results = [];
async function step(name, fn) {
  log(`▶ STEP: ${name}`); hr();
  try { await fn(); results.push([true, name]); log(`✅ OK: ${name}`); }
  catch (e) { results.push([false, name, e.message]); log(`❌ FAIL: ${name}`); kv('ERROR', e.message); throw e; }
}

// ── the txid ledger: a mainnet run's proof must outlive stdout ────────────────────
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LEDGER_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'mainnet-runs');
const LEDGER = path.join(LEDGER_DIR, `presale-${RUN_STAMP}.jsonl`);
fs.mkdirSync(LEDGER_DIR, { recursive: true });
function record(entry) {
  fs.appendFileSync(LEDGER, JSON.stringify({ broadcastAt: new Date().toISOString(), ...entry }) + '\n');
}

// ── chain readers (WoC is the authority; never trust our own arithmetic) ──────────
const woc = (p) => fetch(`https://api.whatsonchain.com/v1/bsv/main${p}`, { cache: 'no-store' });
async function wocRawHex(txid) {
  for (let i = 0; i < 8; i++) {
    const r = await woc(`/tx/${txid}/hex`);
    if (r.ok) { const h = (await r.text()).trim(); if (/^[0-9a-fA-F]+$/.test(h)) return h; }
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  return null;
}
/** Input values, sourced from each PARENT's vout — WoC returns vin[].value as 0. */
async function wocInputValue(txid, vout) {
  for (let i = 0; i < 6; i++) {
    const r = await woc(`/tx/hash/${txid}`);
    if (r.ok) { const j = await r.json(); const v = j?.vout?.[vout]?.value; if (typeof v === 'number') return Math.round(v * 1e8); }
    await new Promise((r2) => setTimeout(r2, 2500));
  }
  return null;
}

const pkhOf = (pubHex) => bsvjs.crypto.Hash.sha256ripemd160(bsvjs.PublicKey.fromString(pubHex).toBuffer()).toString('hex');


/** Chunked STAS batch delivery — the same chain-the-change loop ProjectManage runs. */
async function deliver(batch, start) {
  let cur = start;
  const chunks = [];
  for (let i = 0; i < batch.recipients.length; i += MAX_BATCH_RECIPIENTS) chunks.push(batch.recipients.slice(i, i + MAX_BATCH_RECIPIENTS));
  let lastTxid = '';
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const res = await batchTransferStas(DELIVER_WALLET, '', 'main', {
      source: {
        txid: cur.txid, vout: cur.vout, scriptHex: cur.scriptHex, satoshis: cur.satoshis, beef: cur.beef,
        brc42KeyId: `${batch.slug}-owner`,
        owner: { protocolID: STAS_PROTOCOL, keyID: `${batch.slug}-owner`, counterparty: 'self', forSelf: false },
      },
      recipients: chunk.map((r) => ({ address: r.address, amount: r.amount })),
      senderChangeHash160: cur.scriptHex.substring(6, 46),
    });
    if (!res.ok) throw fail(`batchTransferStas chunk ${c + 1}: ${res.reason}`, {});
    const bc1 = await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
    if (!bc1.ok) throw fail(`delivery funding broadcast: ${bc1.error}`, {});
    const bc2 = await broadcastRawTx(res.rawTx, res.txid);
    if (!bc2.ok) throw fail(`delivery transfer broadcast: ${bc2.error}`, {});
    lastTxid = bc2.txid || res.txid;
    record({ txid: lastTxid, purpose: `stas-delivery-chunk-${c + 1}`, recipients: chunk.length });
    await O.markOrdersSettled(chunk.map((r) => r.orderId), lastTxid);
    kv(`chunk ${c + 1}/${chunks.length}`, wocTx(lastTxid));
    if (res.newPool && c < chunks.length - 1) cur = { ...res.newPool, beef: res.chainBeef };
  }
  if (batch.saleId) kv('orders settled', await prisma.order.count({ where: { saleId: batch.saleId, state: 'settled' } }));
  kv('delivery tx', wocTx(lastTxid));
  return lastTxid;
}

let DELIVER_WALLET = null;

/** Resume mode: deliver a presale whose vault has since confirmed. */
async function deliverOnly(saleId, wallet) {
  DELIVER_WALLET = wallet;
  hr('█'); log(`RESUME — delivering escrow contributions for sale ${saleId}`); hr('█');
  const batch = await O.getBatchForSale(saleId);
  if (!batch.ok) throw new Error(`getBatchForSale: ${batch.error}`);
  const pool0 = await resolveCurrentPool(batch.mintTxid);
  if ('error' in pool0) throw new Error(`resolveCurrentPool: ${pool0.error}`);
  const info0 = await getOutputInfo(pool0.txid, pool0.vout);
  if (!info0) throw new Error('could not fetch the token vault UTXO');
  const beef0 = await getSourceBeef(pool0.txid);
  if (!beef0) throw new Error(`vault tx ${pool0.txid} still unconfirmed — retry later`);
  await deliver({ ...batch, saleId }, { txid: pool0.txid, vout: pool0.vout, scriptHex: info0.scriptHex, satoshis: info0.satoshis, beef: beef0 });
  kv('txid ledger', LEDGER);
}

async function main() {
  hr('█'); log('ADR-025 ESCROW PRESALE — full-stack mainnet round-trip'); hr('█');
  kv('ledger', LEDGER);

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

  // A second contributor on a DIFFERENT key. Aggregating several people's pledges into
  // one transaction is the whole point of an assurance contract, and pledging twice from
  // one wallet never tests it: the signatures would share a key, so a bug that only bites
  // across distinct pubkeys (script/pubkey mismatch, per-input preimage leakage, ordering)
  // would pass. The operator key plays the second contributor here.
  const opWallet = new FlatKeyWallet(opHex, {
    chain: CHAIN, basePkh: pkhOf(op.pubHex),
    baseAddress: op.address, operatorPubHex: op.pubHex,
    fetchUtxos: () => getOperatorBaseUtxos(op.address), fetchBeef: getSourceBeefDeep,
    broadcastChain: broadcastBeefChain,
  });
  const { publicKey: opIdentity } = await opWallet.getPublicKey({ identityKey: true }, ORIGINATOR);
  if (opIdentity === identity) throw new Error('the two contributors resolved to one identity');

  const bal = async (a) => { try { const u = await getOperatorBaseUtxos(a); return u.reduce((s, x) => s + Number(x.satoshis ?? 0), 0); } catch { return 0; } };
  const clientBal = await bal(client.address), opBal = await bal(op.address);
  kv('client addr', `${client.address}  (owner / contributor)`);
  kv('client sats', clientBal);
  kv('operator addr', `${op.address}`  + '  (second contributor)');
  kv('operator sats', opBal);
  if (clientBal < MIN_CLIENT_SATS) throw new Error(`client base ${clientBal} < ${MIN_CLIENT_SATS} — fund ${client.address}`);
  if (opBal < MIN_OPERATOR_SATS) throw new Error(`operator base ${opBal} < ${MIN_OPERATOR_SATS} — it pledges as the second contributor; fund ${op.address}`);

  DELIVER_WALLET = clientWallet;

  const resume = (process.argv.find((a) => a.startsWith('--deliver=')) || '').split('=')[1];
  if (resume) { await deliverOnly(resume, clientWallet); return; }

  const state = { pledges: [] };

  // 1 ── CREATE PROJECT ────────────────────────────────────────────────────────────
  await step('CREATE PROJECT (real createProject)', async () => {
    const stamp = Date.now();
    const fd = new FormData();
    fd.set('name', `E2E Presale ${stamp}`); fd.set('ticker', `$EP${String(stamp).slice(-5)}`);
    fd.set('identityPubkey', identity); fd.set('payoutAddress', client.address);
    fd.set('totalSupply', '1000'); fd.set('priceSats', String(PRICE)); fd.set('publicAllocation', '1000');
    let redirected = '';
    try { await A.createProject(fd); } catch (e) { redirected = e?.digest || e?.message || ''; }
    if (!/ok=1/.test(redirected)) throw fail(`createProject did not succeed (redirect: ${redirected})`, {});
    const project = await prisma.project.findFirst({ where: { owner: { identityPubkey: identity } }, orderBy: { createdAt: 'desc' }, include: { tokens: { include: { sales: true } } } });
    if (!project) throw fail('project row not found', {});
    state.project = project; state.slug = project.slug;
    state.token = project.tokens[0]; state.sale = project.tokens[0].sales[0];
    kv('project', `${project.name} slug=${project.slug}`);
    kv('saleId', state.sale.id);
  });

  // 2 ── APPROVE + CONFIGURE THE PRESALE ───────────────────────────────────────────
  await step('APPROVE + set escrow_presale (real setProjectStatus + updateSaleEscrow)', async () => {
    const fd = new FormData(); fd.set('id', state.project.id); fd.set('status', 'live');
    await A.setProjectStatus(fd);
    const esc = await A.updateSaleEscrow({ projectId: state.project.id, identityPubkey: identity, type: 'escrow_presale', softCapSats: SOFT_CAP, hardCapSats: HARD_CAP, pledgeUnitSats: PLEDGE_UNIT });
    if (!esc.ok) throw fail(`updateSaleEscrow failed: ${esc.error}`, {});
    const sale = await prisma.sale.findUnique({ where: { id: state.sale.id } });
    kv('sale type', sale.type); kv('soft/hard/unit', `${sale.softCap} / ${sale.hardCap} / ${sale.pledgeUnitSats}`);
    if (sale.type !== 'escrow_presale') throw fail('sale.type did not become escrow_presale', {});
    kv('sale status', `${sale.status} (opens at mint — recordIssuance flips it live)`);
    if (PLEDGE_UNIT % PRICE !== 0) throw fail(`pledge unit ${PLEDGE_UNIT} is not a multiple of price ${PRICE} — contributors would be short-changed`, {});
  });

  // 3 ── MINT the supply (the owner's own issuance — this is what opens the sale) ─
  await step('MINT STAS supply (real issueStasGenesis + recordIssuance)', async () => {
    const symbol = state.token.ticker.replace(/^\$/, '');
    const g = await issueStasGenesis(clientWallet, clientIdentityKey, CHAIN, {
      slug: state.slug, symbol, supply: Number(STAS_SUPPLY), splittable: true, name: state.project.name,
    });
    if (!g.ok) throw fail(`issueStasGenesis failed: ${g.reason}`, {});
    const cbc = await broadcastRawTx(g.contractRawTx, g.contractTxid);
    if (!cbc.ok) throw fail(`contract broadcast rejected: ${cbc.error}`, {});
    record({ txid: g.contractTxid, purpose: 'stas-contract' });
    let ibc = await broadcastRawTx(g.issueRawTx, g.genesisTxid);
    for (let i = 0; i < 6 && !ibc.ok && /missing inputs/i.test(ibc.error ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      await broadcastRawTx(g.contractRawTx, g.contractTxid);
      ibc = await broadcastRawTx(g.issueRawTx, g.genesisTxid);
    }
    if (!ibc.ok) throw fail(`issue broadcast rejected: ${ibc.error}`, {});
    state.issuanceTxid = ibc.txid || g.genesisTxid;
    record({ txid: state.issuanceTxid, purpose: 'stas-genesis', tokenId: g.tokenId });

    await M.recordIssuance(state.project.id, state.issuanceTxid, g.tokenId);
    const sale = await prisma.sale.findUnique({ where: { id: state.sale.id } });
    kv('issuanceTxid', state.issuanceTxid); kv('tx', wocTx(state.issuanceTxid));
    kv('sale status', sale.status);
    if (sale.status !== 'live') throw fail(`sale did not open after issuance (status ${sale.status}) — a presale could never accept a pledge`, {});
  });

  // ── helper: one contributor pledge (mint own UTXO, sign 0xC1, register) ─────────
  const CONTRIBUTORS = {
    one: { wallet: clientWallet, identity, receive: client.address, label: 'client' },
    two: { wallet: opWallet, identity: opIdentity, receive: op.address, label: 'operator-as-contributor' },
  };

  async function makePledge(label, who = CONTRIBUTORS.one) {
    const p = await createPledge(who.wallet, CHAIN, { pledgeUnitSats: PLEDGE_UNIT, softCapSats: SOFT_CAP, projectAddress: client.address });
    if (!p.ok) throw fail(`createPledge(${label}) failed: ${p.reason}`, {});
    const bc = await broadcastRawTx(p.fundingRawTx, p.utxo.txid);
    if (!bc.ok && !/already|known/i.test(bc.error ?? '')) throw fail(`pledge ${label} funding broadcast rejected: ${bc.error}`, {});
    record({ txid: p.utxo.txid, purpose: `pledge-funding-${label}`, satoshis: p.utxo.satoshis, contributor: who.label });
    const rp = await E.recordPledge({
      saleId: state.sale.id, contributor: who.identity, receiveAddress: who.receive,
      txid: p.utxo.txid, vout: p.utxo.vout, satoshis: p.utxo.satoshis, scriptHex: p.utxo.scriptHex,
      sigHex: p.sigHex, pubkeyHex: p.pubkeyHex,
      derivationPrefix: p.utxo.derivationPrefix, derivationSuffix: p.utxo.derivationSuffix,
    });
    kv(`pledge ${label}`, `${p.utxo.txid}:${p.utxo.vout}  ${p.utxo.satoshis} sats  by ${who.label}  record=${rp.ok ? 'ok' : rp.error}`);
    return { ...p, recorded: rp, who };
  }

  // 4 ── TWO PLEDGES fill the soft cap ─────────────────────────────────────────────
  await step('PLEDGE x2 from TWO DIFFERENT contributors — each keeps custody', async () => {
    const a = await makePledge('A', CONTRIBUTORS.one); if (!a.recorded.ok) throw fail(`recordPledge A: ${a.recorded.error}`, {});
    const b = await makePledge('B', CONTRIBUTORS.two); if (!b.recorded.ok) throw fail(`recordPledge B: ${b.recorded.error}`, {});
    if (a.pubkeyHex === b.pubkeyHex) throw fail('both pledges signed with the same key — multi-party aggregation is untested', {});
    kv('distinct keys', `${a.pubkeyHex.slice(0, 16)}… vs ${b.pubkeyHex.slice(0, 16)}…`);
    state.pledges.push(a, b); state.pledgeB = b;
    const bRow = await prisma.pledge.findFirst({ where: { saleId: state.sale.id, txid: b.utxo.txid, vout: b.utxo.vout } });
    if (!bRow) throw fail('pledge B row not found after recordPledge', {});
    state.pledgeBId = bRow.id;
    // The two phases are exclusive: while pledges are still being gathered there is
    // nothing to buy, and reserveOrder — not just the UI — has to say so.
    const early = await O.reserveOrder({ projectId: state.project.id, buyerIdentity: opIdentity, receiveAddress: op.address, tokens: 1 });
    kv('buy in pledge phase', early.ok ? 'ALLOWED' : `refused — ${early.error}`);
    if (early.ok) throw fail('an instant buy was accepted during the pledge phase', {});

    const st = await E.getPresaleState(state.sale.id);
    kv('raised', `${st.raisedSats} / ${SOFT_CAP} sats  (${st.pledgeCount} pledges)`);
    if (Number(st.raisedSats) !== SOFT_CAP) throw fail(`raised ${st.raisedSats} != soft cap ${SOFT_CAP}`, {});
  });

  // 5 ── THE TRUSTLESS REFUND: contributor B reclaims their own pledge ────────────
  await step('WITHDRAW — contributor B reclaims their pledge with no operator cooperation', async () => {
    // NOT a basket check. FlatKeyWallet.listOutputs ignores its arguments and returns
    // base UTXOs, so querying PLEDGE_BASKET here once printed a count that looked like
    // a pass and meant nothing. Whether a wallet honours or shows a basket cannot be
    // answered by this shim; it took a real wallet to find out that it does neither
    // usefully. Left as a label only.
    kv('pledge basket', `${PLEDGE_BASKET} — set on the output; NOT verifiable here (shim ignores basket)`);

    const b = state.pledgeB;
    const src = await getSourceBeefDeep(b.utxo.txid);
    if (!src) throw fail('could not load the pledge ancestry needed to reclaim it', {});
    const w = await withdrawPledge(b.who.wallet, CHAIN, {
      utxo: b.utxo, feeSats: WITHDRAW_FEE, sourceBeef: src,
    });
    if (!w.ok) throw fail(`withdrawPledge failed: ${w.reason} — the contributor CANNOT reclaim their pledge, which breaks ADR-025's core trustless claim`, {});
    const bc = await broadcastRawTx(w.rawTx, w.txid);
    if (!bc.ok) throw fail(`withdraw broadcast rejected: ${bc.error}`, {});
    record({ txid: w.txid, purpose: 'pledge-withdraw-B', reclaimed: w.reclaimedSats });
    kv('reclaimed', `${w.reclaimedSats} sats`); kv('withdraw tx', wocTx(w.txid));

    // WoC's spent index lags a just-broadcast spend by seconds, and "unspent" and
    // "not indexed yet" are the SAME bare 404 — so asserting immediately is a race we
    // happened to win four runs in a row. Poll before concluding.
    let spent = { unspent: null };
    for (let i = 0; i < 8; i++) {
      spent = await isOutputUnspent(b.utxo.txid, b.utxo.vout);
      if (spent.unspent === false) break;
      if (i < 7) await new Promise((r) => setTimeout(r, 5000));
    }
    kv('pledge B unspent?', `${spent.unspent}${spent.spentBy ? ` (spent by ${spent.spentBy.slice(0, 12)}…)` : ''}`);
    if (spent.unspent !== false) throw fail('pledge B still reads unspent after the withdrawal broadcast (polled 40s)', spent);

    // HONEST LIMIT: FlatKeyWallet.internalizeAction is a best-effort no-op stub, so this
    // harness CANNOT prove the refund is adopted back into a wallet's spendable balance.
    // It proves the coin moves and lands at a key the contributor derives. Whether a real
    // wallet then shows it is a BSV Desktop question, not one this shim can answer.
    kv('internalise', 'NOT VERIFIABLE here — FlatKeyWallet.internalizeAction is a stub');

    const mk = await E.markPledgeWithdrawn(state.pledgeBId, b.who.identity, w.txid);
    if (!mk.ok) throw fail(`markPledgeWithdrawn failed: ${mk.error}`, {});
    state.withdrawTxid = w.txid;
  });

  // 6 ── RECOVERY: the presale must survive a withdrawal ───────────────────────────
  await step('RECOVER — a withdrawn pledge must free its slot for a replacement', async () => {
    const st = await E.getPresaleState(state.sale.id);
    kv('raised (reported)', `${st.raisedSats} / ${SOFT_CAP}`);
    if (Number(st.raisedSats) !== PLEDGE_UNIT) {
      throw fail(`raised reads ${st.raisedSats} but only ${PLEDGE_UNIT} sats are actually pledged — the withdrawn pledge is still counted, overstating the raise to contributors`, {});
    }
    const c = await makePledge('C', CONTRIBUTORS.two);
    if (!c.recorded.ok) throw fail(`replacement pledge REJECTED: ${c.recorded.error} — a withdrawal permanently bricks the presale`, {});
    state.pledges.push(c);
  });

  // 6.5 ── THE DEADLINE must be the server's rule, not the UI's ───────────────────
  // No broadcasts here: this drives the real server actions against the real DB with
  // the sale window moved, which is exactly where the gate lives. Pledge state is
  // restored at the end so the run continues into assembly.
  await step('DEADLINE — the close is enforced server-side, and a dead raise expires', async () => {
    const saleId = state.sale.id;
    const restore = () => prisma.sale.update({ where: { id: saleId }, data: { endsAt: null } });

    // (a) past the close, a new pledge is refused. The window is checked BEFORE the
    //     duplicate-outpoint guard, so re-submitting a known outpoint reaches it.
    await prisma.sale.update({ where: { id: saleId }, data: { endsAt: new Date(Date.now() - 60_000) } });
    const a = state.pledges[0];
    const late = await E.recordPledge({
      saleId, contributor: a.who.identity, receiveAddress: a.who.receive,
      txid: a.utxo.txid, vout: a.utxo.vout, satoshis: a.utxo.satoshis, scriptHex: a.utxo.scriptHex,
      sigHex: a.sigHex, pubkeyHex: a.pubkeyHex,
      derivationPrefix: a.utxo.derivationPrefix, derivationSuffix: a.utxo.derivationSuffix,
    });
    kv('pledge after close', late.ok ? 'ACCEPTED' : `refused — ${late.error}`);
    if (late.ok) throw fail('a pledge was accepted after the deadline — the close is UI-only', {});
    if (!/deadline/i.test(late.error ?? '')) throw fail(`refused for the wrong reason: ${late.error}`, {});

    // (b) inside the settlement grace, assembly is still allowed — filling to the last
    //     moment then settling is the normal shape of an assurance contract.
    const sel = await E.getPledgesForAssembly(saleId, identity);
    kv('assembly in grace', sel.ok ? 'allowed' : `blocked — ${sel.error}`);
    if (!sel.ok) throw fail(`assembly blocked inside the grace window: ${sel.error}`, {});

    // (c) past the grace, assembly is refused and the pledges expire.
    await prisma.sale.update({ where: { id: saleId }, data: { endsAt: new Date(Date.now() - 25 * 3600_000) } });
    const stale = await E.getPledgesForAssembly(saleId, identity);
    kv('assembly past grace', stale.ok ? 'ALLOWED' : `refused — ${stale.error}`);
    if (stale.ok) throw fail('a stale pledge set was still assemblable — 0xC1 signatures never expire on their own', {});

    const expired = await prisma.pledge.count({ where: { saleId, state: 'expired' } });
    kv('expired pledges', expired);
    if (expired === 0) throw fail('a dead raise did not expire its pledges', {});

    // (d) an expired pledge must STILL be withdrawable — that is when it matters most.
    const lists = await Promise.all(
      [CONTRIBUTORS.one, CONTRIBUTORS.two].map((w) => E.getMyPledges(saleId, w.identity)),
    );
    const reclaimable = lists.reduce((n, l) => n + l.length, 0);
    kv('withdrawable', `${reclaimable} across ${lists.filter((l) => l.length).length} contributor(s) — expired must stay reclaimable`);
    if (reclaimable !== expired) throw fail(`only ${reclaimable} of ${expired} expired pledges are withdrawable`, {});

    // (e) a dead raise must not advertise a total it will never collect.
    const st = await E.getPresaleState(saleId);
    kv('raised after expiry', `${st.raisedSats} (must be 0)`);
    if (Number(st.raisedSats) !== 0) throw fail(`expired presale still reports ${st.raisedSats} raised`, {});

    await restore();
    await prisma.pledge.updateMany({ where: { saleId, state: 'expired' }, data: { state: 'pledged' } });
    kv('restored', 'endsAt cleared, pledges back to pledged');
  });

  // 7 ── ASSEMBLE the assurance tx ─────────────────────────────────────────────────
  await step('ASSEMBLE + BROADCAST the assurance transaction', async () => {
    const sel = await E.getPledgesForAssembly(state.sale.id, identity);
    if (!sel.ok) throw fail(`getPledgesForAssembly failed: ${sel.error}`, {});
    const keys = new Set(sel.pledges.map((p) => p.pubkeyHex));
    kv('selected pledges', `${sel.pledges.length} summing to ${sel.pledges.reduce((s, p) => s + p.satoshis, 0)} across ${keys.size} key(s)`);
    if (keys.size < 2) throw fail(`assembling ${keys.size} distinct key(s) — the multi-party case is what an assurance contract is FOR`, {});
    if (sel.pledges.some((p) => p.txid === state.pledgeB.utxo.txid)) throw fail('assembly selected the WITHDRAWN pledge — the assurance tx would be invalid', {});

    const asm = await assembleAssuranceTx(clientWallet, CHAIN, { pledges: sel.pledges, softCapSats: sel.softCapSats, projectAddress: sel.projectAddress });
    if (!asm.ok) throw fail(`assembleAssuranceTx failed: ${asm.reason}`, {});
    kv('estimated fee', `${asm.feeSats} sats`);
    const fb = await broadcastRawTx(asm.feeFundingRawTx, '');
    kv('fee funding', fb.ok ? 'ok' : `(${fb.error})`);
    let bc = await broadcastRawTx(asm.assuranceRawTx, asm.assuranceTxid);
    for (let i = 0; i < 6 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      await broadcastRawTx(asm.feeFundingRawTx, '');
      bc = await broadcastRawTx(asm.assuranceRawTx, asm.assuranceTxid);
    }
    if (!bc.ok) throw fail(`assurance broadcast REJECTED: ${bc.error}`, { estimatedFee: asm.feeSats, localSize: asm.assuranceRawTx.length / 2 });
    state.assuranceTxid = bc.txid || asm.assuranceTxid;
    state.selected = sel;
    record({ txid: state.assuranceTxid, purpose: 'assurance', estimatedFeeSats: asm.feeSats, pledgeCount: sel.pledges.length });
    kv('assurance tx', wocTx(state.assuranceTxid));
  });

  // 8 ── VERIFY THE BYTES A MINER SAW (never our own arithmetic) ───────────────────
  await step('VERIFY on-chain — real size, real fee, real fee rate, frozen output set', async () => {
    const raw = await wocRawHex(state.assuranceTxid);
    if (!raw) throw fail('WoC never served the assurance tx hex', {});
    const trueSize = raw.length / 2;
    const parsed = Transaction.fromHex(raw);

    let inSum = 0;
    for (const vin of parsed.inputs) {
      const v = await wocInputValue(vin.sourceTXID, vin.sourceOutputIndex);
      if (v == null) throw fail(`could not read parent value for ${vin.sourceTXID}:${vin.sourceOutputIndex}`, {});
      inSum += v;
    }
    const outSum = parsed.outputs.reduce((s, o) => s + Number(o.satoshis), 0);
    const feePaid = inSum - outSum;
    const rate = feePaid / trueSize;

    kv('true size', `${trueSize} bytes`);
    kv('inputs', `${parsed.inputs.length} totalling ${inSum} sats`);
    kv('outputs', `${parsed.outputs.length} totalling ${outSum} sats`);
    kv('fee PAID', `${feePaid} sats`);
    kv('fee RATE', `${rate.toFixed(4)} sat/B`);

    if (parsed.outputs.length !== 1) throw fail(`assurance tx has ${parsed.outputs.length} outputs — every pledge signed SIGHASH_ALL over exactly one`, {});
    if (outSum !== SOFT_CAP) throw fail(`output pays ${outSum}, soft cap is ${SOFT_CAP}`, {});
    if (feePaid <= 0) throw fail(`non-positive fee ${feePaid}`, {});
    const paidTo = parsed.outputs[0].lockingScript.toHex();
    if (!paidTo.includes(pkhOf(client.pubHex))) throw fail('the single output does not pay the project payout address', { paidTo });
    state.chain = { trueSize, feePaid, rate, inSum, outSum };
    record({ txid: state.assuranceTxid, purpose: 'assurance-verified', trueSize, feePaid, feeRate: Number(rate.toFixed(4)) });
  });

  // 9 ── FUNDED PLEDGES BECOME DELIVERABLE ORDERS ──────────────────────────────────
  await step('RECORD assembly — pledges become settle-eligible Orders', async () => {
    const ids = state.selected.pledges.map((p) => p.id);
    const mk = await E.markAssemblyBroadcast(state.sale.id, identity, state.assuranceTxid, ids);
    if (!mk.ok) throw fail(`markAssemblyBroadcast failed: ${mk.error}`, {});
    const orders = await prisma.order.findMany({ where: { saleId: state.sale.id, kind: 'escrow_contribution' } });
    kv('orders created', orders.length);
    for (const o of orders) kv('  order', `${o.id} tokens=${o.tokens} sats=${o.satsPaid} state=${o.state}`);
    if (orders.length !== ids.length) throw fail(`expected ${ids.length} orders, got ${orders.length}`, {});
    const expectTokens = BigInt(PLEDGE_UNIT / PRICE);
    for (const o of orders) if (o.tokens !== expectTokens) throw fail(`order ${o.id} credits ${o.tokens} tokens, expected ${expectTokens} — contributor short-changed`, {});
    state.orderIds = orders.map((o) => o.id);
  });

  // 9.5 ── THE SECOND PHASE: instant buy above the soft cap ────────────────────────
  await step('TOP-UP — with the soft cap funded, the sale switches to instant buy', async () => {
    const TOKENS = 5, cost = TOKENS * PRICE;
    const vm = await prisma.pledge.count({ where: { saleId: state.sale.id, state: 'assembled' } });
    kv('assembled pledges', `${vm} (this is what flips the sale to its buy phase)`);

    const res = await O.reserveOrder({
      projectId: state.project.id, buyerIdentity: opIdentity, receiveAddress: op.address, tokens: TOKENS,
    });
    if (!res.ok) throw fail(`reserveOrder refused after the soft cap was funded: ${res.error}`, {});
    kv('reserved', `${res.orderId} for ${TOKENS} tokens (${cost} sats)`);

    // Buyer pays the project's payout address. The cost is recomputed server-side in
    // confirmOrderPayment and verified ON-CHAIN, so the number sent here is not trusted.
    const payScript = new P2PKH().lock(client.address).toHex();
    const pay = await opWallet.createAction({
      description: 'presale top-up payment',
      outputs: [{ lockingScript: payScript, satoshis: cost, outputDescription: 'top-up' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    }, ORIGINATOR);
    if (!pay?.txid) throw fail('top-up payment createAction returned no txid', {});
    let payRaw = ''; try { payRaw = Transaction.fromAtomicBEEF(pay.tx).toHex(); } catch { payRaw = ''; }
    const bc = await broadcastRawTx(payRaw, pay.txid);
    if (!bc.ok && !/already|known/i.test(bc.error ?? '')) throw fail(`top-up payment broadcast rejected: ${bc.error}`, {});
    const payTxid = bc.txid || pay.txid;
    record({ txid: payTxid, purpose: 'topup-payment', satoshis: cost, tokens: TOKENS });
    kv('paid', `${cost} sats -> ${client.address}  ${wocTx(payTxid)}`);

    const conf = await O.confirmOrderPayment(res.orderId, cost, payTxid);
    if (!conf.ok) throw fail(`confirmOrderPayment failed: ${conf.error}`, {});
    const order = await prisma.order.findUnique({ where: { id: res.orderId } });
    kv('order', `${order.kind} ${order.tokens} tokens state=${order.state}`);
    if (order.state !== 'pending') throw fail(`order is ${order.state}, not settle-eligible`, {});
    state.topUpOrderId = res.orderId;

    // Over-selling the hard cap must still be impossible.
    const over = await O.reserveOrder({
      projectId: state.project.id, buyerIdentity: opIdentity, receiveAddress: op.address, tokens: 9999,
    });
    kv('over hard cap', over.ok ? 'ALLOWED' : `refused — ${over.error}`);
    if (over.ok) throw fail('a buy beyond the sale allocation was accepted', {});
  });

  // 10 ── DELIVER the tokens (mirrors ProjectManage.batchSettle exactly) ──────────
  await step('DELIVER — batch-settle the contribution orders into real STAS', async () => {
    const batch = await O.getBatchForSale(state.sale.id);
    if (!batch.ok) throw fail(`getBatchForSale failed: ${batch.error} — escrow contributions never surface for settlement`, {});
    kv('recipients', batch.recipients.map((r) => `${r.amount}->${r.address.slice(0, 10)}…`).join(', '));
    const kinds = await prisma.order.groupBy({ by: ['kind'], where: { saleId: state.sale.id, state: 'pending' }, _count: true });
    kv('order kinds', kinds.map((k) => `${k.kind}x${k._count}`).join(' + ') + '  (pledges and top-ups settle together)');

    const pool0 = await resolveCurrentPool(batch.mintTxid);
    if ('error' in pool0) throw fail(`resolveCurrentPool: ${pool0.error}`, {});
    const info0 = await getOutputInfo(pool0.txid, pool0.vout);
    if (!info0) throw fail('could not fetch the token vault UTXO', {});
    const total = batch.recipients.reduce((s2, r) => s2 + r.amount, 0);
    if (total > info0.satoshis) throw fail(`vault holds ${info0.satoshis} tokens; batch needs ${total}`, {});

    // Settlement needs a merkle-proof BEEF, so the vault tx must be CONFIRMED.
    // Blocks have taken hours in this project — do not fail the run over it.
    const beef0 = await getSourceBeef(pool0.txid);
    if (!beef0) {
      state.deliveryDeferred = true;
      kv('DEFERRED', `vault tx ${pool0.txid} is not confirmed yet — settlement needs a merkle proof`);
      kv('resume with', `pnpm --filter @launchpad/web e2e:presale -- --deliver=${state.sale.id}`);
      record({ txid: pool0.txid, purpose: 'delivery-deferred-unconfirmed-vault', saleId: state.sale.id });
      return;
    }
    await deliver({ ...batch, saleId: state.sale.id }, { txid: pool0.txid, vout: pool0.vout, scriptHex: info0.scriptHex, satoshis: info0.satoshis, beef: beef0 });
  });

  hr('█'); log('SUMMARY'); hr('█');
  for (const [ok, name, err] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`);
  if (state.chain) {
    hr(); kv('assurance size', `${state.chain.trueSize} B`); kv('fee paid', `${state.chain.feePaid} sats`); kv('fee rate', `${state.chain.rate.toFixed(4)} sat/B`);
  }
  kv('txid ledger', LEDGER);
}

main().then(() => process.exit(0)).catch((e) => {
  hr('█'); console.error('RUN FAILED:', e.message);
  for (const [ok, name, err] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`);
  console.log(`  txid ledger: ${LEDGER}`);
  process.exit(1);
});
