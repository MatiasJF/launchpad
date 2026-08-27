/**
 * e2e-merkle-app.mjs — the ADR-030 pool through the REAL app, on REAL mainnet.
 *
 * Drives the actual `'use server'` actions (`merkle-ledger-actions.ts`) against the real Prisma
 * database and the real chain — no mocks, no dry run. It exists to prove the claim that makes the
 * trustless track worth having:
 *
 *   **the app reads pool state from the BLOCKCHAIN, not from its own database.**
 *
 * So after every trade it re-reads through `getMerklePool` and asserts the chain-derived numbers,
 * and it deliberately never writes ledger state anywhere. It also DOWNLOADS every broadcast
 * transaction back from WhatsOnChain and reports the real size, fee and effective sat/byte, because
 * the computed values are assumptions and only the chain is evidence.
 *
 * Run:  pnpm --filter @launchpad/web e2e:merkle
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

register('./lib/stub-next.mjs', pathToFileURL('./scripts/'));

const { PrivateKey, P2PKH, Transaction, Script } = await import('@bsv/sdk');
const { prisma } = await import('@launchpad/db');
const actions = await import('../lib/merkle-ledger-actions.ts');
const { verifiedUnspent, reportTx } = await import(new URL('../../../packages/curve/service/dist/service/wocInspect.js', import.meta.url).href);
const bsvLib = (await import('bsv')).default ?? (await import('bsv'));

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FEE_RATE = 0.01; // ADR-031, measured
const K = '1', SUPPLY = '60', SEED = 546;

const keyHex = (fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const pkh = Buffer.from(priv.toPublicKey().toHash()).toString('hex');
const identity = priv.toPublicKey().toString();
const unlock = () => new P2PKH().unlock(priv, 'all', false);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); } };
const log = (s) => console.log(s);

async function broadcast(rawTx, label) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }) });
    const body = (await res.text()).trim();
    if (res.ok) { const t = body.replace(/"/g, ''); log(`  ✓ ${label}: ${t}`); return t; }
    if (res.status !== 429 && !/rate|limit|50[023]/i.test(body)) throw new Error(`${label} rejected: ${body}`);
    await sleep(2500 * (i + 1));
  }
  throw new Error(`${label} failed`);
}

/** Spend the pool with a server-built unlock + our own funding input. */
async function spendPool({ poolTxid, poolVout, sourceLockHex, unlockingHex, fundingTx, fundingVout, outputs, label }) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: poolTxid, sourceOutputIndex: poolVout, unlockingScript: Script.fromHex(unlockingHex), sequence: 0xffffffff });
  tx.addInput({ sourceTransaction: fundingTx, sourceOutputIndex: fundingVout, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  for (const o of outputs) tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.satoshis });
  await tx.sign();
  return broadcast(tx.toHex(), label);
}

async function main() {
  log(`wallet: ${address}`);
  log('\n*** LIVE MAINNET — ADR-030 through the real server actions + real DB ***\n');

  // ── seed a project/token/sale so the owner-gated actions have something real to gate on ──
  const slug = `merkle-e2e-${Date.now().toString(36)}`;
  const account = await prisma.account.upsert({ where: { identityPubkey: identity }, create: { identityPubkey: identity }, update: {} });
  const project = await prisma.project.create({ data: { slug, name: 'Merkle E2E', status: 'approved', payoutAddress: address, owner: { connect: { id: account.id } } } });
  const token = await prisma.token.create({ data: { projectId: project.id, name: 'Merkle E2E Token', ticker: 'MERK', totalSupply: BigInt(SUPPLY) } });
  const sale = await prisma.sale.create({ data: { tokenId: token.id, type: 'bonding_curve', status: 'live', priceSats: BigInt(1), allocationForSale: BigInt(SUPPLY) } });
  log(`▶ SETUP — project ${slug}, sale ${sale.id.slice(0, 10)}…`);

  // ── 1. createMerklePool (owner-gated) ──────────────────────────────────────
  log('\n▶ 1. createMerklePool — owner-gated, returns the genesis script');
  const created = await actions.createMerklePool({ saleId: sale.id, identityPubkey: identity, k: K, supply: SUPPLY, seedReserveSats: SEED });
  check('pool created', created.ok === true, created.error);
  check('genesis script returned', !!created.scriptHex && created.scriptHex.length > 20000, `${created.scriptHex?.length}`);

  const notOwner = await actions.createMerklePool({ saleId: sale.id, identityPubkey: PrivateKey.fromRandom().toPublicKey().toString(), k: K, supply: SUPPLY, seedReserveSats: SEED });
  check('a non-owner is refused', notOwner.ok === false && /not the project owner/i.test(notOwner.error ?? ''));

  // ── 2. deploy the pool + funding outputs on mainnet ─────────────────────────
  log('\n▶ 2. DEPLOY the genesis script on mainnet');
  const fundBuy = 4000, fundSell = 1200; // the sell fee input is consumed WHOLE — sized from prepareMerkleSell.feeInputSats below
  const need = SEED + fundBuy + fundSell + 2000;
  const { utxos, staleCount, total } = await verifiedUnspent(address);
  log(`  wallet: ${total.toLocaleString()} sats VERIFIED unspent (${staleCount} stale entries skipped)`);
  const src = utxos.find((u) => u.value >= need);
  if (!src) throw new Error(`no verified-unspent UTXO >= ${need}`);
  // WoC rate-limits; an un-validated body comes back as an error string and then Transaction
  // .fromHex throws a bare "Invalid hex string" that says nothing about the real cause.
  let pHex = null;
  for (let i = 0; i < 6 && !pHex; i++) {
    const r = await fetch(`${WOC}/tx/${src.tx_hash}/hex`, { cache: 'no-store' });
    const body = (await r.text()).trim();
    if (r.ok && /^[0-9a-fA-F]+$/.test(body) && body.length > 100) pHex = body;
    else { log(`  parent fetch attempt ${i + 1} failed (${r.status}) — retrying`); await sleep(2500 * (i + 1)); }
  }
  if (!pHex) throw new Error('could not fetch the funding parent tx hex from WoC');

  const deploy = new Transaction();
  deploy.addInput({ sourceTransaction: Transaction.fromHex(pHex), sourceOutputIndex: src.tx_pos, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  deploy.addOutput({ lockingScript: Script.fromHex(created.scriptHex), satoshis: SEED });
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundBuy });
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: fundSell });
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
  await deploy.fee();
  await deploy.sign();
  const genesisTxid = await broadcast(deploy.toHex(), 'DEPLOY');
  await sleep(6000);
  await reportTx(genesisTxid, 'deploy');

  // ── 3. markMerklePoolDeployed — verifies the outpoint against the CHAIN ─────
  log('\n▶ 3. markMerklePoolDeployed — the action re-resolves it from chain before trusting it');
  const wrong = await actions.markMerklePoolDeployed({ saleId: sale.id, identityPubkey: identity, genesisTxid: 'f'.repeat(64) });
  check('a bogus genesis txid is refused', wrong.ok === false, wrong.error);
  const marked = await actions.markMerklePoolDeployed({ saleId: sale.id, identityPubkey: identity, genesisTxid, genesisVout: 0 });
  check('real genesis accepted', marked.ok === true, marked.error);

  // ── 4. getMerklePool reads FROM CHAIN ──────────────────────────────────────
  log('\n▶ 4. getMerklePool — state comes from the blockchain, not the database');
  let view = await actions.getMerklePool(sale.id);
  check('pool resolves', view.ok === true, view.error);
  check('fresh pool: sold 0', view.sold === 0, `${view.sold}`);
  check('fresh pool: reserve == seed', view.reserveSats === SEED, `${view.reserveSats}`);
  check('fresh pool: no holders', view.holderCount === 0);
  check('tip == genesis while unspent', view.poolTxid === genesisTxid);

  // prove the DB really holds no ledger
  const row = await prisma.curvePool.findUnique({ where: { saleId: sale.id } });
  check('DB stores the genesis pointer', row.genesisTxid === genesisTxid);
  check('DB holds NO ledger mirror', row.ledgerBalances === null || row.ledgerBalances === undefined, `${row.ledgerBalances}`);

  // ── 5. BUY through the server action ───────────────────────────────────────
  const DELTA = 40;
  log(`\n▶ 5. prepareMerkleBuy — credit ${DELTA} (keyless; nobody signs the credit)`);
  const buy = await actions.prepareMerkleBuy({ saleId: sale.id, buyerPkh: pkh, delta: DELTA });
  check('buy prepared', buy.ok === true, buy.error);
  log(`  cost ${buy.cost} · reserve ${buy.reserveBefore} → ${buy.newReserve}`);
  const buyChange = fundBuy - buy.cost - Math.ceil((buy.unlockingHex.length / 2 + buy.nextLockingHex.length / 2 + 400) * FEE_RATE);
  const buyOuts = [{ scriptHex: buy.nextLockingHex, satoshis: buy.newReserve }];
  if (buyChange >= 546) buyOuts.push({ scriptHex: `76a914${pkh}88ac`, satoshis: buyChange });
  const buyTxid = await spendPool({ poolTxid: buy.poolTxid, poolVout: buy.poolVout, sourceLockHex: buy.sourceLockHex, unlockingHex: buy.unlockingHex, fundingTx: deploy, fundingVout: 1, outputs: buyOuts, label: 'BUY' });
  await sleep(6000);
  const buyFacts = await reportTx(buyTxid, 'buy');
  check('buy tx fee rate is near the calibrated 0.01', buyFacts.feeRate > 0.005 && buyFacts.feeRate < 0.05, `${buyFacts.feeRate.toFixed(4)} sat/B`);
  await actions.recordMerkleTrade({ saleId: sale.id, identity, ownerPkh: pkh, kind: 'curve_buy', tokens: DELTA, sats: buy.cost, txid: buyTxid });

  log('\n  re-reading state — the buy must be visible FROM CHAIN:');
  view = await actions.getMerklePool(sale.id);
  check('sold reflects the buy', view.sold === DELTA, `${view.sold}`);
  check('holder balance from chain', view.balances.find((b) => b.ownerPkh === pkh)?.amount === DELTA);
  check('reserve grew by the cost', view.reserveSats === SEED + buy.cost, `${view.reserveSats}`);
  check('tip moved to the buy', view.poolTxid === buyTxid);
  check('holderCount is 1', view.holderCount === 1);

  // ── 6. SELL through the server action (holder-signed) ──────────────────────
  // DERIVE the sell amount: the curve refund must clear the 546-sat dust floor, and that threshold
  // moves with `sold`. Hardcoding it has broken three harnesses now — the guard was right each time.
  const refundAt = (sold, a) => Number((BigInt(a) * (2n * BigInt(sold - a) + BigInt(a) + 1n)) / 2n);
  let AMOUNT = 0;
  for (let a = 1; a <= view.sold; a++) if (refundAt(view.sold, a) >= 600) { AMOUNT = a; break; }
  if (!AMOUNT) throw new Error(`no sell amount within ${view.sold} clears the dust floor`);
  log(`\n▶ 6. prepareMerkleSell — debit ${AMOUNT} (derived: refund ${refundAt(view.sold, AMOUNT)} clears dust), signed by the HOLDER`);
  const sellPrep = await actions.prepareMerkleSell({ saleId: sale.id, sellerPkh: pkh, amount: AMOUNT });
  check('sell prepared', sellPrep.ok === true, sellPrep.error);
  log(`  refund ${sellPrep.refund} · reserve → ${sellPrep.reserveAfter} · fee input must be exactly ${sellPrep.feeInputSats} sats`);
  check('the action tells the caller the exact fee-input size', typeof sellPrep.feeInputSats === 'number' && sellPrep.feeInputSats > 0, `${sellPrep.feeInputSats}`);

  // pre-size the fee UTXO to the quoted value — the covenant allows no change output on a sell
  const feePrep = new Transaction();
  feePrep.addInput({ sourceTransaction: deploy, sourceOutputIndex: 2, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  feePrep.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: sellPrep.feeInputSats });
  const feeChange = fundSell - sellPrep.feeInputSats - 60;
  if (feeChange >= 546) feePrep.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: feeChange });
  await feePrep.sign();
  await broadcast(feePrep.toHex(), 'FEE-UTXO');
  await sleep(5000);

  const der = bsvLib.crypto.ECDSA.sign(Buffer.from(sellPrep.digestHex, 'hex'), bsvLib.PrivateKey.fromString(keyHex)).toDER().toString('hex');
  const sellFin = await actions.finalizeMerkleSell({ saleId: sale.id, sellerPkh: pkh, ownerPubHex: identity, amount: AMOUNT, payoutScriptHex: sellPrep.payoutScriptHex, sigDerHex: der });
  check('sell unlock built from the holder signature', sellFin.ok === true, sellFin.error);

  const sellTxid = await spendPool({
    poolTxid: sellPrep.poolTxid, poolVout: sellPrep.poolVout, sourceLockHex: sellFin.sourceLockHex, unlockingHex: sellFin.unlockingHex,
    fundingTx: feePrep, fundingVout: 0,
    outputs: [{ scriptHex: sellFin.nextLockingHex, satoshis: sellPrep.reserveAfter }, { scriptHex: sellPrep.payoutScriptHex, satoshis: sellPrep.refund }],
    label: 'SELL',
  });
  await sleep(6000);
  const sellFacts = await reportTx(sellTxid, 'sell');
  check('sell paid the refund to the holder', sellFacts.outputs[1].satoshis === sellPrep.refund, `${sellFacts.outputs[1].satoshis} vs ${sellPrep.refund}`);
  check('sell has exactly 2 outputs (covenant pins them)', sellFacts.outputs.length === 2, `${sellFacts.outputs.length}`);
  check('sell fee rate is near the calibrated 0.01 (no longer 12x overpaid)', sellFacts.feeRate > 0.005 && sellFacts.feeRate < 0.05, `${sellFacts.feeRate.toFixed(4)} sat/B`);
  await actions.recordMerkleTrade({ saleId: sale.id, identity, ownerPkh: pkh, kind: 'curve_sell', tokens: AMOUNT, sats: sellPrep.refund, txid: sellTxid });

  // ── 7. final read, and the guards ──────────────────────────────────────────
  log('\n▶ 7. FINAL — read back from chain, then check the guards');
  view = await actions.getMerklePool(sale.id);
  check('sold after sell', view.sold === DELTA - AMOUNT, `${view.sold}`);
  check('balance after sell', view.balances.find((b) => b.ownerPkh === pkh)?.amount === DELTA - AMOUNT);
  check('reserve after sell', view.reserveSats === sellPrep.reserveAfter, `${view.reserveSats}`);
  check('history has 2 ops, read from chain', view.history.length === 2, `${view.history.length}`);
  check('not graduated', view.graduated === false);

  const oversell = await actions.prepareMerkleSell({ saleId: sale.id, sellerPkh: pkh, amount: 9999 });
  check('overselling is refused', oversell.ok === false && /insufficient/i.test(oversell.error ?? ''), oversell.error);
  const overbuy = await actions.prepareMerkleBuy({ saleId: sale.id, buyerPkh: pkh, delta: 9999 });
  check('buying past supply is refused', overbuy.ok === false && /exceeds/i.test(overbuy.error ?? ''), overbuy.error);
  const earlyGrad = await actions.prepareMerkleGraduate({ saleId: sale.id });
  check('graduating early is refused', earlyGrad.ok === false && /not fully sold/i.test(earlyGrad.error ?? ''), earlyGrad.error);

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  log(`sale: ${sale.id} (slug ${slug})`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('\n❌', e?.message ?? e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
