/* eslint-disable no-console */
/**
 * e2e-stas.mjs — SELF-DRIVING mainnet end-to-end harness for the stas bonding curve
 * (ADR-028, Option B). Runs a full DEPLOY → MINT → BUY → DELIVER → SELL → REFUND
 * round-trip with NO human wallet signing: the OPERATOR wallet plays every role
 * (deployer, buyer, seller). Real mainnet, tiny sats. It exists to REPRODUCE + FIX
 * the live delivery/BEEF/provenance bugs fast, so it logs every step loudly and, on
 * ANY failure, dumps the full error + the relevant raw tx hex / BEEF so the throw is
 * diagnosable without a wallet in the loop.
 *
 * RUN:  pnpm --filter @launchpad/web e2e:stas
 *   (which is: node --import tsx scripts/e2e-stas.mjs — tsx so we can import the
 *    workspace TS packages directly; this is NOT Next and imports nothing 'server-only'.)
 *
 * It is CHAIN-ONLY: it drives packages/curve + packages/bsv + the pure WoC/Beef chain
 * helpers directly. It does NOT touch Prisma or the 'use server' server actions — it
 * replicates the guts of deliverStasToBuyer / finalizeStasSell inline (minus the DB).
 *
 * REUSE (one implementation, no forks):
 *   • operator custody wallet  → ../lib/operator-toolbox.ts   (makeOperatorWallet — pure)
 *   • genesis reserve covenant → packages/curve/service CLI    (stas-genesis, same as stas-service.ts)
 *   • assembly                 → @launchpad/curve              (buildStasBuyTx, buildStasSellRefundTx, curveCost)
 *   •                          → @launchpad/bsv                (issueStasGenesis, operatorDeliverStas, transferStas)
 *   • chain helpers            → ../lib/settle-actions.ts      (getSourceBeef(Deep), resolveCurrentPool,
 *                                 getOutputInfo, broadcastRawTx, verifyStasBackToGenesis,
 *                                 findStasOutputToPkh, isOutputUnspent)  ← imported directly under tsx
 *                                 (the 'use server' directive is an inert string outside Next;
 *                                  none of its deps are Next/Prisma, so it loads as a plain module).
 *   • operator flat-key roles  → replicated INLINE here with bsv-js (getOperator + operatorSignDigest),
 *                                 because operator-wallet.ts is 'server-only'. Same math, same key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { KeyDeriver, PrivateKey, PublicKey, Transaction } from '@bsv/sdk';

import { makeOperatorWallet, walletBalanceSats } from '../lib/operator-toolbox.ts';
import { curveCost, buildStasBuyTx, buildStasSellRefundTx } from '@launchpad/curve';
import { issueStasGenesis } from '@launchpad/bsv/genesis';
import { operatorDeliverStas, transferStas } from '@launchpad/bsv/settle';
import {
  getSourceBeef,
  getSourceBeefDeep,
  resolveCurrentPool,
  getOutputInfo,
  broadcastRawTx,
  verifyStasBackToGenesis,
  findStasOutputToPkh,
  isOutputUnspent,
} from '../lib/settle-actions.ts';


// ── curve params (a TINY demo pool so a full mainnet round-trip is cheap) ──────
const K = 1n;
const SUPPLY = 3n;
const SEED_RESERVE_SATS = 546;
const DELTA = 1; // buy/sell one token
const CHAIN = 'main';
const STAS_PROTOCOL = [2, '3241645161d8']; // canonical STAS BRC-42 owner protocol (ADR-021)
const ORIGINATOR = 'launchpad.e2e';
// ~worst-case sats the operator must have on hand for one run (seed + fundings/fees).
const MIN_OPERATOR_SATS = 2500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const STAS_GENESIS_CLI = path.join(REPO_ROOT, 'packages/curve/service/dist/service/cli.js');

// ── logging ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const ms = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const hr = (c = '─') => console.log(c.repeat(78));
function log(...a) { console.log(`[${ms()}]`, ...a); }
function kv(label, val) { console.log(`    ${label.padEnd(16)} ${val}`); }
function wocTx(txid) { return `https://whatsonchain.com/tx/${txid}`; }

const steps = [];
async function step(name, fn) {
  hr('═');
  log(`▶ STEP: ${name}`);
  hr();
  try {
    const out = await fn();
    log(`✅ OK: ${name}`);
    steps.push({ name, ok: true });
    return out;
  } catch (err) {
    log(`❌ FAIL: ${name}`);
    console.error('    ERROR:', err instanceof Error ? (err.stack || err.message) : String(err));
    if (err && err.__dump) dump(err.__dump); // structured diagnostics attached to the throw
    steps.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Attach diagnostics (raw tx hex, beef, createAction shape …) to a thrown error. */
function fail(message, dumpObj) {
  const e = new Error(message);
  if (dumpObj) e.__dump = dumpObj;
  return e;
}

function dump(obj) {
  hr('·');
  console.error('    ── DIAGNOSTIC DUMP ──');
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) { console.error(`    ${k}: <null>`); continue; }
    if (Array.isArray(v)) {
      // a byte array (beef) → length + hex head + base64
      const bytes = v;
      const hex = Buffer.from(bytes).toString('hex');
      console.error(`    ${k}: ${bytes.length} bytes`);
      console.error(`      hex[0..160]: ${hex.slice(0, 160)}${hex.length > 160 ? '…' : ''}`);
      console.error(`      base64     : ${Buffer.from(bytes).toString('base64')}`);
    } else if (typeof v === 'string' && /^[0-9a-fA-F]{64,}$/.test(v)) {
      console.error(`    ${k}: ${v.length / 2} bytes (raw tx hex)`);
      console.error(`      ${v}`);
    } else if (typeof v === 'object') {
      console.error(`    ${k}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n    ')}`);
    } else {
      console.error(`    ${k}: ${v}`);
    }
  }
  hr('·');
}

// ── operator flat-key roles (replicated inline; operator-wallet.ts is 'server-only') ──
let BSV; // bsv-js v1, lazily loaded
async function loadBsv() {
  if (!BSV) { const m = await import('bsv'); BSV = m.default ?? m; }
  return BSV;
}
function readOperatorKeyHex() {
  const envPath = path.join(__dirname, '..', '.env');
  const txt = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const m = txt.match(/^OPERATOR_KEY=(.+)$/m);
  const keyHex = (m ? m[1] : '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('OPERATOR_KEY missing or not 64-char hex in apps/web/.env — run operator:setup');
  }
  return keyHex;
}
async function getOperator(keyHex) {
  const bsv = await loadBsv();
  const p = bsv.PrivateKey.fromString(keyHex);
  const pub = p.toPublicKey();
  return {
    pubHex: pub.toString(),
    pkh: bsv.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex'),
    address: pub.toAddress().toString(),
  };
}
function makeOperatorSignDigest(keyHex) {
  return async function operatorSignDigest(digestHex) {
    const bsv = await loadBsv();
    const p = bsv.PrivateKey.fromString(keyHex);
    const sig = bsv.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p);
    const N = bsv.crypto.Point.getN();
    if (sig.s.gt(N.div(new bsv.crypto.BN(2)))) sig.s = N.sub(sig.s); // low-S
    return sig.toDER().toString('hex');
  };
}

// ── broadcast: parent (TX1) before child, retrying while TX1 propagates ──────────
async function broadcastWithParent(parentRaw, parentTxid, rawTx, id, label) {
  if (parentRaw) {
    const pb = await broadcastRawTx(parentRaw, parentTxid);
    log(`  ${label} · parent broadcast:`, pb.ok ? `ok ${pb.txid || parentTxid}` : `(${pb.error})`);
  }
  let bc = await broadcastRawTx(rawTx, id);
  for (let i = 0; i < 6 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
    log(`  ${label} · child not ready (missing inputs), retry ${i + 1}/6…`);
    await new Promise((r) => setTimeout(r, 2500));
    if (parentRaw) await broadcastRawTx(parentRaw, parentTxid);
    bc = await broadcastRawTx(rawTx, id);
  }
  return bc;
}

function rawFromCreateAction(res) {
  // wallet.createAction returns { txid, tx: number[] (atomic BEEF) }
  try { return Transaction.fromAtomicBEEF(res.tx).toHex(); } catch { return ''; }
}

// ────────────────────────────────────────────────────────────────────────────────
async function main() {
  hr('█');
  log('SELF-DRIVING stas bonding-curve mainnet E2E harness (ADR-028)');
  kv('curve', `k=${K} supply=${SUPPLY} seed=${SEED_RESERVE_SATS} sats delta=${DELTA}`);
  hr('█');

  const keyHex = readOperatorKeyHex();
  const signCovenant = makeOperatorSignDigest(keyHex);
  const op = await getOperator(keyHex);
  const slug = `e2e-stas-${Date.now()}`; // fresh pool each run (chain-only, no DB)
  const symbol = `E2E${String(Date.now()).slice(-5)}`;

  kv('operator pkh', op.pkh);
  kv('operator addr', op.address);
  kv('vault (mint→)', `hash160(operator pub) = ${op.pkh}`);
  kv('run slug', slug);

  // Operator custody wallet (toolbox) — funds/broadcasts + plays buyer & seller.
  const wallet = await makeOperatorWallet(keyHex);
  const identityKey = new KeyDeriver(new PrivateKey(keyHex, 'hex')).identityKey;

  const startBal = await walletBalanceSats(wallet);
  kv('operator sats', `${startBal} (start)`);
  if (startBal < MIN_OPERATOR_SATS) {
    throw new Error(
      `operator balance ${startBal} sats is below ~${MIN_OPERATOR_SATS} needed for a run — ` +
      `FUND THE OPERATOR (npx fund-metanet to ${op.address} / store-us-1.bsvb.tech) and retry.`,
    );
  }

  // Buyer/seller STAS owner address — derived from the SAME wallet, EXACTLY as the
  // UI does (getPublicKey protocolID=STAS keyID=slug counterparty=self, no forSelf).
  const { publicKey: ownerPub } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'self' }, ORIGINATOR);
  const receiveAddress = PublicKey.fromString(ownerPub).toAddress().toString();
  kv('buyer STAS addr', receiveAddress);

  const state = {}; // carries txids/pool between steps

  // 1 ── DEPLOY ──────────────────────────────────────────────────────────────────
  await step('DEPLOY reserve covenant (seed the pool)', async () => {
    log('building genesis reserve-covenant via stas-genesis CLI…');
    if (!fs.existsSync(STAS_GENESIS_CLI)) {
      throw new Error(`stas service CLI not built at ${STAS_GENESIS_CLI} — run: pnpm --filter @launchpad/curve build:service`);
    }
    const out = execFileSync('node', [STAS_GENESIS_CLI, 'stas-genesis', JSON.stringify({ k: K.toString(), supply: SUPPLY.toString(), operatorPkh: op.pkh })], { maxBuffer: 16 * 1024 * 1024 });
    const { scriptHex: covenantHex } = JSON.parse(out.toString());
    kv('covenant bytes', covenantHex.length / 2);

    log('funding + broadcasting the seed reserve output from the operator wallet…');
    let res;
    try {
      res = await wallet.createAction({
        description: 'e2e stas pool deploy',
        outputs: [{ lockingScript: covenantHex, satoshis: SEED_RESERVE_SATS, outputDescription: 'stas curve pool reserve' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      }, ORIGINATOR);
    } catch (e) {
      // createAction runs inside the operator TOOLBOX custody wallet (store-us-1.bsvb.tech).
      // A "merged Beef failed validation" here is the STORAGE server rejecting the action
      // (stale/dead unconfirmed-chain BEEF in the wallet), NOT a covenant/assembly fault —
      // capture the full underlying stack so its origin (StorageClient.rpcCall) is visible.
      throw fail(`deploy createAction threw: ${e instanceof Error ? e.message : String(e)}`, {
        underlyingStack: e instanceof Error ? e.stack : String(e),
        covenantHex,
      });
    }
    if (!res?.txid) throw fail('deploy createAction returned no txid', { createActionResult: safeShape(res), covenantHex });

    const rawTx = rawFromCreateAction(res);
    // locate the covenant output vout (change output is appended after it).
    let poolVout = -1;
    try {
      const tx = Transaction.fromHex(rawTx);
      poolVout = tx.outputs.findIndex((o) => o.lockingScript.toHex().toLowerCase() === covenantHex.toLowerCase());
    } catch { /* fall back to 0 */ }
    if (poolVout < 0) poolVout = 0;

    const bc = await broadcastRawTx(rawTx, res.txid);
    if (!bc.ok) throw fail(`deploy broadcast rejected: ${bc.error}`, { deployRawTx: rawTx, createActionResult: safeShape(res) });

    const txid = bc.txid || res.txid;
    state.pool = { txid, vout: poolVout, scriptHex: covenantHex, reserveSats: SEED_RESERVE_SATS, sold: 0, k: Number(K), supply: Number(SUPPLY) };
    kv('pool outpoint', `${txid}:${poolVout}`);
    kv('tx', wocTx(txid));
  });

  // 2 ── MINT ──────────────────────────────────────────────────────────────────
  await step('MINT full supply as STAS into the operator vault', async () => {
    // redemption anchor (tokenId) is wallet-derived inside issueStasGenesis; owner
    // override = operator flat pubkey so the whole supply locks to the vault.
    const { publicKey: redemptionPubkey } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: `${slug}-redeem`, counterparty: 'self' }, ORIGINATOR);
    kv('owner override', `${op.pubHex.slice(0, 16)}… (operator vault)`);

    let g;
    try {
      g = await issueStasGenesis(wallet, identityKey, CHAIN, { slug, symbol, supply: Number(SUPPLY), ownerPubHex: op.pubHex });
    } catch (e) {
      throw fail(`issueStasGenesis threw: ${e instanceof Error ? e.message : String(e)}`, {});
    }
    if (!g.ok) throw fail(`issueStasGenesis failed: ${g.reason}`, {});

    log('broadcasting CONTRACT then ISSUE…');
    const cbc = await broadcastRawTx(g.contractRawTx, g.contractTxid);
    if (!cbc.ok) throw fail(`contract broadcast rejected: ${cbc.error}`, { contractRawTx: g.contractRawTx });
    let ibc = await broadcastRawTx(g.issueRawTx, g.genesisTxid);
    for (let i = 0; i < 6 && !ibc.ok && /missing inputs/i.test(ibc.error ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      await broadcastRawTx(g.contractRawTx, g.contractTxid);
      ibc = await broadcastRawTx(g.issueRawTx, g.genesisTxid);
    }
    if (!ibc.ok) throw fail(`issue broadcast rejected: ${ibc.error}`, { issueRawTx: g.issueRawTx, contractTxid: g.contractTxid });

    state.issuanceTxid = ibc.txid || g.genesisTxid;
    state.tokenId = g.tokenId;
    kv('contract txid', g.contractTxid);
    kv('issuanceTxid', state.issuanceTxid);
    kv('tokenId', g.tokenId);
    kv('tx', wocTx(state.issuanceTxid));
  });

  // 3 ── BUY (operator acts as buyer) ─────────────────────────────────────────────
  await step('BUY delta reserve (TX-A, buyer-signed)', async () => {
    const cost = Number(curveCost(K, BigInt(state.pool.sold), BigInt(DELTA)));
    kv('curve cost', `${cost} sats (delta=${DELTA} at sold=${state.pool.sold})`);

    let built;
    try {
      built = await buildStasBuyTx({ wallet, chain: CHAIN, pool: state.pool, delta: DELTA });
    } catch (e) {
      throw fail(`buildStasBuyTx threw: ${e instanceof Error ? e.message : String(e)}`, { pool: state.pool });
    }
    if (!built.ok) throw fail(`buildStasBuyTx failed: ${built.reason}`, { pool: state.pool });

    kv('TX-A txid', built.txid);
    kv('paymentTxid', built.paymentTxid);
    const bc = await broadcastWithParent(built.paymentRawTx, built.paymentTxid, built.rawTx, built.txid, 'BUY');
    if (!bc.ok) throw fail(`buy broadcast rejected: ${bc.error}`, { buyRawTx: built.rawTx, paymentRawTx: built.paymentRawTx, newPool: built.newPool });

    state.pool = { ...built.newPool, k: Number(K), supply: Number(SUPPLY) };
    kv('new pool', `${state.pool.txid}:${state.pool.vout} reserve=${state.pool.reserveSats} sold=${state.pool.sold}`);
    kv('tx', wocTx(bc.txid || built.txid));
  });

  // 4 ── DELIVER (operator delivers STAS to the buyer) ─── the historical failure point
  await step('DELIVER STAS from vault to buyer (TX-B, operator-signed)', async () => {
    log('resolving current vault UTXO on-chain (resolveCurrentPool)…');
    const vault = await resolveCurrentPool(state.issuanceTxid);
    if ('error' in vault) throw fail(`resolve vault failed: ${vault.error}`, { issuanceTxid: state.issuanceTxid });
    kv('vault outpoint', `${vault.txid}:${vault.vout}`);

    const info = await getOutputInfo(vault.txid, vault.vout);
    if (!info) throw fail('could not fetch vault UTXO script/value', { vault });
    kv('vault tokens', info.satoshis);
    if (info.satoshis < DELTA) throw fail(`vault holds ${info.satoshis} tokens, need ${DELTA}`, { vault, info });

    log('building UNCONFIRMED-SAFE ancestry BEEF (getSourceBeefDeep) — this is the delivery money path…');
    const beef = await getSourceBeefDeep(vault.txid);
    if (!beef) {
      throw fail('getSourceBeefDeep returned null — could not anchor vault ancestry to a confirmed root', {
        vaultTxid: vault.txid,
        note: 'the vault tip is unconfirmed (fresh mint / prior hop); deep walk failed to reach a mined root within budget',
      });
    }
    kv('vault beef', `${beef.length} bytes`);

    log('calling operatorDeliverStas (fee from toolbox wallet, token co-sign via flat key)…');
    let res;
    try {
      res = await operatorDeliverStas({
        feeWallet: wallet,
        chain: CHAIN,
        source: { txid: vault.txid, vout: vault.vout, scriptHex: info.scriptHex, satoshis: info.satoshis, beef },
        recipientAddress: receiveAddress,
        amount: DELTA,
        vaultChangeHash160: op.pkh,
        tokenOwnerPubHex: op.pubHex,
        signTokenDigest: signCovenant,
      });
    } catch (e) {
      throw fail(`operatorDeliverStas THREW: ${e instanceof Error ? (e.stack || e.message) : String(e)}`, { vaultBeef: beef, vaultSource: { txid: vault.txid, vout: vault.vout, scriptHex: info.scriptHex, satoshis: info.satoshis } });
    }
    if (!res.ok) {
      // THE "merged Beef failed validation" surface — dump everything relevant.
      throw fail(`operatorDeliverStas FAILED: ${res.reason}`, {
        deliverReason: res.reason,
        vaultSource: { txid: vault.txid, vout: vault.vout, scriptHex: info.scriptHex, satoshis: info.satoshis },
        vaultBeef: beef,
        recipientAddress,
        vaultChangeHash160: op.pkh,
        tokenOwnerPubHex: op.pubHex,
      });
    }

    kv('TX-B txid', res.txid);
    kv('funding txid', res.fundingTxid);
    if (res.fundingRawTx) kv('funding raw', `${res.fundingRawTx.length / 2} bytes`);
    if (res.newVault) kv('new vault', `${res.newVault.txid}:${res.newVault.vout} (${res.newVault.satoshis} tokens change)`);

    log('broadcasting funding (TX1) then delivery (TX-B)…');
    const bc = await broadcastWithParent(res.fundingRawTx, res.fundingTxid, res.rawTx, res.txid, 'DELIVER');
    if (!bc.ok) {
      throw fail(`delivery broadcast rejected: ${bc.error}`, {
        deliveryRawTx: res.rawTx,
        fundingRawTx: res.fundingRawTx,
        deliveryBeef: res.beef,
      });
    }
    state.deliveryTxid = bc.txid || res.txid;
    kv('delivered', state.deliveryTxid);
    kv('tx', wocTx(state.deliveryTxid));
  });

  // 5 ── SELL back (operator as seller): TX1 return, verify, TX2 refund ────────────
  await step('SELL delta back — TX1 STAS return to vault', async () => {
    log('resolving the delivered STAS UTXO (resolveCurrentPool over the delivery)…');
    const cur = await resolveCurrentPool(state.deliveryTxid);
    if ('error' in cur) throw fail(`could not resolve delivered STAS: ${cur.error}`, { deliveryTxid: state.deliveryTxid });
    const info = await getOutputInfo(cur.txid, cur.vout);
    if (!info) throw fail('could not fetch delivered STAS script/value', { cur });
    kv('holding', `${cur.txid}:${cur.vout} = ${info.satoshis} tokens`);
    if (info.satoshis < DELTA) throw fail(`holding ${info.satoshis} < delta ${DELTA}`, { cur, info });

    // Unconfirmed-safe BEEF so the harness can sell immediately (delivery is in mempool).
    let beef = await getSourceBeef(cur.txid);
    if (!beef) {
      log('  /beef 404 (delivery unconfirmed) → falling back to getSourceBeefDeep for the return source…');
      beef = await getSourceBeefDeep(cur.txid);
    }
    if (!beef) throw fail('could not build ancestry BEEF for the delivered STAS (return source)', { holdingTxid: cur.txid });
    kv('source beef', `${beef.length} bytes`);

    const vaultAddress = op.address; // return STAS to the operator vault (base P2PKH)
    let res;
    try {
      res = await transferStas(wallet, identityKey, CHAIN, {
        source: {
          txid: cur.txid, vout: cur.vout, scriptHex: info.scriptHex, satoshis: info.satoshis,
          brc42KeyId: slug,
          owner: { protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'self', forSelf: false },
          beef,
        },
        recipientAddress: vaultAddress,
        amount: DELTA,
        senderChangeHash160: info.scriptHex.substring(6, 46),
      });
    } catch (e) {
      throw fail(`transferStas (STAS return) THREW: ${e instanceof Error ? (e.stack || e.message) : String(e)}`, { source: { txid: cur.txid, vout: cur.vout, scriptHex: info.scriptHex, satoshis: info.satoshis }, sourceBeef: beef });
    }
    if (!res.ok) throw fail(`transferStas (STAS return) failed: ${res.reason}`, { rawTx: res.rawTx, sourceBeef: beef });

    kv('TX1 txid', res.txid);
    const bc = await broadcastWithParent(res.fundingRawTx, res.fundingTxid, res.rawTx, res.txid, 'RETURN');
    if (!bc.ok) throw fail(`STAS return broadcast rejected: ${bc.error}`, { returnRawTx: res.rawTx, fundingRawTx: res.fundingRawTx });
    state.returnTxid = bc.txid || res.txid;
    kv('returned', state.returnTxid);
    kv('tx', wocTx(state.returnTxid));
  });

  await step('SELL — verify returned STAS back-to-genesis', async () => {
    // The full send makes output 0 the vault return; confirm + locate it.
    const returned = await findStasOutputToPkh(state.returnTxid, op.pkh, DELTA);
    const returnVout = returned?.vout ?? 0;
    kv('return outpoint', `${state.returnTxid}:${returnVout}`);

    const unspent = await isOutputUnspent(state.returnTxid, returnVout);
    kv('unspent', String(unspent.unspent));

    const auth = await verifyStasBackToGenesis({ outpointTxid: state.returnTxid, outpointVout: returnVout, issuanceTxid: state.issuanceTxid });
    kv('authentic', `${auth.authentic}${auth.reason ? ` (${auth.reason})` : ''}${auth.nodes != null ? ` [${auth.nodes} nodes]` : ''}`);
    if (!auth.authentic) throw fail(`back-to-genesis FAILED: ${auth.reason} — would refuse refund`, { returnTxid: state.returnTxid, returnVout, issuanceTxid: state.issuanceTxid });
    state.returnVout = returnVout;
  });

  await step('SELL — TX2 reserve refund (operator co-signed)', async () => {
    const bsv = await loadBsv();
    const sellerRefundScriptHex = bsv.Script.buildPublicKeyHashOut(bsv.Address.fromString(op.address)).toHex();

    let res;
    try {
      res = await buildStasSellRefundTx({
        feeWallet: wallet,
        chain: CHAIN,
        pool: state.pool,
        delta: DELTA,
        sellerRefundScriptHex,
        operatorPubHex: op.pubHex,
        signCovenant,
      });
    } catch (e) {
      throw fail(`buildStasSellRefundTx THREW: ${e instanceof Error ? (e.stack || e.message) : String(e)}`, { pool: state.pool });
    }
    if (!res.ok) throw fail(`buildStasSellRefundTx failed: ${res.reason}`, { pool: state.pool, sellerRefundScriptHex });

    kv('refund', `${res.refund} sats → ${op.address}`);
    kv('reserveAfter', res.reserveAfter);
    kv('TX2 txid', res.txid);
    const bc = await broadcastWithParent(res.fundingRawTx, res.fundingTxid, res.rawTx, res.txid, 'REFUND');
    if (!bc.ok) throw fail(`refund broadcast rejected: ${bc.error}`, { refundRawTx: res.rawTx, fundingRawTx: res.fundingRawTx, newPool: res.newPool });
    state.refundTxid = bc.txid || res.txid;
    state.pool = { ...res.newPool, k: Number(K), supply: Number(SUPPLY) };
    kv('refunded', state.refundTxid);
    kv('tx', wocTx(state.refundTxid));
  });

  const endBal = await walletBalanceSats(wallet);
  return { startBal, endBal, state };
}

function safeShape(o) {
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) out[k] = `Array(${v.length})`;
    else if (v && typeof v === 'object') out[k] = '{…}';
    else out[k] = v;
  }
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────────
let result = null;
let fatal = null;
try {
  result = await main();
} catch (e) {
  fatal = e;
}

hr('█');
log('SUMMARY');
hr('█');
for (const s of steps) console.log(`  ${s.ok ? '✅' : '❌'} ${s.name}${s.ok ? '' : `  — ${s.error}`}`);
if (result) {
  hr();
  kv('operator sats', `${result.startBal} → ${result.endBal} (Δ ${result.endBal - result.startBal})`);
  console.log('\n  txids:');
  for (const [k, v] of Object.entries(result.state)) {
    if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) console.log(`    ${k.padEnd(14)} ${wocTx(v)}`);
  }
}
hr('█');
if (fatal) {
  const failedAt = steps.find((s) => !s.ok);
  console.log(`\n  RESULT: ❌ FAILED${failedAt ? ` at: ${failedAt.name}` : ''}`);
  console.log(`  first failure: ${fatal instanceof Error ? fatal.message : String(fatal)}\n`);
  process.exit(1);
} else {
  console.log('\n  RESULT: ✅ PASS — full deploy→mint→buy→deliver→sell→refund round-trip landed on mainnet\n');
  process.exit(0);
}
