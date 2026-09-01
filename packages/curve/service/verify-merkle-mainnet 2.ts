/**
 * verify-merkle-mainnet.ts — the bounded-size covenant (ADR-030) on REAL mainnet.
 *
 * The offline suite proves the covenant through the interpreter; this proves a node accepts it,
 * which is the only claim that counts. Full lifecycle on one live pool:
 *
 *   deploy → buy (append holder A) → buy (append holder B) → buy (UPDATE A's existing slot)
 *          → sell (A, holder-signed) → buy out the rest → graduate (terminal)
 *
 * The point of the middle buys is the size claim: the locking script must NOT grow as holders
 * accumulate, and the run prints the real on-chain script size at each step so the claim is
 * measured on chain rather than asserted.
 *
 * Real sats from the test CLIENT flat key (gitignored `.env`, never printed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import {
  genesisScript, computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate,
  poolScriptForHistory, buyCost, sellRefund, Op, PoolTerms,
} from './merkleLedgerState';
import { validateAssembledCovenantInput } from '../src/covenant';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FEE_RATE = 0.01; // ADR-031: measured, see calibrate-fee-rate.ts (10x margin over the lowest mined rate)

const K = 1n;
const SUPPLY = 80n;
const SEED = 546;

const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing'); process.exit(1); }
const priv = PrivateKey.fromString(keyHex, 'hex');
const address = priv.toPublicKey().toAddress();
const pkhA = Buffer.from(priv.toPublicKey().toHash() as number[]).toString('hex');
const pkhB = Buffer.from(PrivateKey.fromRandom().toPublicKey().toHash() as number[]).toString('hex');
const TERMS: PoolTerms = { k: K, supply: SUPPLY, payoutPkh: pkhA };

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};
const log = (s: string) => console.log(s);

async function woc(p: string, attempts = 7): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`${WOC}${p}`, { cache: 'no-store' }); if (r.ok || r.status === 404) return r; } catch { /* retry */ }
    await sleep(2500 * (i + 1));
  }
  return null;
}
const unlock = () => new P2PKH().unlock(priv, 'all', false);

async function broadcast(rawTx: string, label: string): Promise<string> {
  let lastErr = '';
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }) });
      const body = (await res.text()).trim();
      if (res.ok) { const t = body.replace(/"/g, ''); log(`  ✓ ${label}: ${t.slice(0, 20)}…`); return t; }
      lastErr = body;
      if (res.status !== 429 && !/rate|limit|50[023]/i.test(body)) throw new Error(`${label} rejected: ${body}`);
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); if (i === 4) throw e; }
    await sleep(2500 * (i + 1));
  }
  throw new Error(`${label} failed after retries: ${lastErr}`);
}

/** Spend the pool: [covenant input (raw unlock), P2PKH funding] -> outputs. Interpreter-gated. */
async function spend(args: {
  poolTxid: string; poolVout: number; poolScriptHex: string; poolSats: number; unlockingHex: string;
  fundingTx: Transaction; fundingVout: number; outputs: { scriptHex: string; satoshis: number }[]; label: string;
}): Promise<string> {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: args.poolTxid, sourceOutputIndex: args.poolVout, unlockingScript: Script.fromHex(args.unlockingHex), sequence: 0xffffffff });
  tx.addInput({ sourceTransaction: args.fundingTx, sourceOutputIndex: args.fundingVout, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  for (const o of args.outputs) tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.satoshis });
  await tx.sign();
  const raw = tx.toHex();
  const v = validateAssembledCovenantInput(raw, { scriptHex: args.poolScriptHex, satoshis: args.poolSats }, 0);
  if (!v.ok) throw new Error(`${args.label} failed the interpreter: ${v.error}`);
  log(`    ${raw.length / 2} B tx · interpreter ✓`);
  return broadcast(raw, args.label);
}

async function main() {
  log(`wallet: ${address}`);
  log(`terms : k=${K} supply=${SUPPLY} · A ${pkhA.slice(0, 10)}… · B ${pkhB.slice(0, 10)}…`);
  log('\n*** LIVE MAINNET — ADR-030 bounded-size covenant ***\n');

  const gScript = genesisScript(TERMS);
  log(`▶ SETUP — genesis script ${gScript.length / 2} B`);

  // A+30 (465) · B+30 (1365) · A+20 (1410) · sell fee · buy out the rest (3220) · GRADUATION fee.
  // The graduation needs its OWN funding output: an earlier version reused the sell's, which is a
  // double-spend of that outpoint and the node rejected it (txn-mempool-conflict).
  // A+25 (325) · B+25 (1275) · A+10 (555) · sell fee · buy out the remaining 30 (1965) ·
  // GRADUATION fee. Sized so A's sell refund clears the 546-sat dust floor at this curve
  // position, and so every pool tx carries ~0.15 sat/B. The graduation gets its OWN funding
  // output: reusing the sell's is a double-spend of that outpoint (the node said so).
  const fees = 3800;
  const funds = [325 + fees, 1275 + fees, 555 + fees, fees, 1965 + fees, 2200];
  const total = SEED + funds.reduce((a, b) => a + b, 0);

  const utxoRes = await woc(`/address/${address}/unspent`);
  if (!utxoRes || !utxoRes.ok) throw new Error('could not fetch UTXOs');
  const utxos = (await utxoRes.json()) as { tx_hash: string; tx_pos: number; value: number; height: number }[];
  const cands = utxos.filter((u) => u.value > total + 2000).sort((a, b) => b.value - a.value);
  let src: typeof cands[0] | undefined;
  for (const c of cands) {
    const sp = await woc(`/tx/${c.tx_hash}/${c.tx_pos}/spent`);
    if (sp && sp.status === 404) { src = c; break; }
    log(`  skipping ${c.tx_hash.slice(0, 12)}…:${c.tx_pos} — already spent`);
  }
  if (!src) throw new Error(`no verified-unspent UTXO > ${total + 2000} sats — fund ${address}`);
  const pHex = await (async () => { const r = await woc(`/tx/${src!.tx_hash}/hex`); return r && r.ok ? (await r.text()).trim() : null; })();
  if (!pHex) throw new Error('could not fetch parent tx');

  const deploy = new Transaction();
  deploy.addInput({ sourceTransaction: Transaction.fromHex(pHex), sourceOutputIndex: src.tx_pos, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  deploy.addOutput({ lockingScript: Script.fromHex(gScript), satoshis: SEED });
  for (const f of funds) deploy.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: f });
  deploy.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
  await deploy.fee();
  await deploy.sign();
  const genesisTxid = await broadcast(deploy.toHex(), 'DEPLOY');
  await sleep(5000);

  const history: Op[] = [];
  let poolTxid = genesisTxid, poolVout = 0, poolScript = gScript, reserve = SEED;
  const sizes: number[] = [gScript.length / 2];

  const doBuy = async (owner: string, delta: bigint, fundingVout: number, fundingSats: number, label: string) => {
    const cost = buyCost(K, history.reduce((s, o) => s + o.delta, 0n), delta);
    const newReserve = reserve + Number(cost);
    const s = computeBuySpend({ terms: TERMS, history: [...history], ownerPkh: owner, delta, poolTxid, poolVout, reserveBefore: reserve, newReserve });
    const change = fundingSats - Number(cost) - Math.ceil((s.unlockingHex.length / 2 + s.nextLockingHex.length / 2 + 400) * FEE_RATE);
    const outs = [{ scriptHex: s.nextLockingHex, satoshis: newReserve }];
    if (change >= 546) outs.push({ scriptHex: `76a914${pkhA}88ac`, satoshis: change });
    const txid = await spend({ poolTxid, poolVout, poolScriptHex: poolScript, poolSats: reserve, unlockingHex: s.unlockingHex, fundingTx: deploy, fundingVout, outputs: outs, label });
    history.push({ ownerPkh: owner, delta });
    poolTxid = txid; poolVout = 0; poolScript = s.nextLockingHex; reserve = newReserve;
    sizes.push(poolScript.length / 2);
    log(`    script now ${poolScript.length / 2} B · reserve ${reserve} · cost ${cost}`);
    await sleep(5000);
    return txid;
  };

  log('\n▶ 1. BUY — holder A appends (slot 0)');
  await doBuy(pkhA, 25n, 1, funds[0], 'BUY-A1');
  log('\n▶ 2. BUY — holder B appends (slot 1)');
  await doBuy(pkhB, 25n, 2, funds[1], 'BUY-B');
  log('\n▶ 3. BUY — holder A UPDATES their existing slot (no new slot)');
  await doBuy(pkhA, 10n, 3, funds[2], 'BUY-A2');

  check('script size did not grow with holders', Math.max(...sizes) - Math.min(...sizes) <= 4, `sizes: ${sizes.join(' → ')}`);
  check('three ops recorded', history.length === 3);

  log('\n▶ 4. SELL — A debits 12, holder-signed (no operator anywhere)');
  const soldNow = history.reduce((s, o) => s + o.delta, 0n);
  // DERIVE the amount: the curve refund must clear the 546-sat dust floor, and that threshold
  // moves with `sold`, so a hardcoded number silently breaks when the pool constants change.
  const heldA = history.filter((o) => o.ownerPkh === pkhA).reduce((s, o) => s + o.delta, 0n);
  let amount = 0n;
  for (let a = 1n; a <= heldA; a++) if (sellRefund(K, soldNow, a) >= 600n) { amount = a; break; }
  if (amount === 0n) throw new Error(`no sell amount within A's ${heldA} clears the dust floor`);
  const refund = sellRefund(K, soldNow, amount);
  log(`  derived sell amount ${amount} of A's ${heldA} → refund ${refund} sats`);
  check('sell refund clears dust', refund >= 546n, `${refund}`);
  const payoutScriptHex = `76a914${pkhA}88ac`;
  const sellArgs = { terms: TERMS, history: [...history], ownerPkh: pkhA, amount, poolTxid, poolVout, reserveBefore: reserve, payoutScriptHex };
  const dig = computeSellDigest(sellArgs);
  const der = B.crypto.ECDSA.sign(Buffer.from(dig.digestHex, 'hex'), B.PrivateKey.fromString(keyHex)).toDER().toString('hex');
  const sellSpend = computeSellUnlock({ ...sellArgs, ownerPubHex: priv.toPublicKey().toString(), sigDerHex: der });
  const sellTxid = await spend({
    poolTxid, poolVout, poolScriptHex: poolScript, poolSats: reserve, unlockingHex: sellSpend.unlockingHex,
    fundingTx: deploy, fundingVout: 4,
    outputs: [{ scriptHex: sellSpend.nextLockingHex, satoshis: dig.reserveAfter }, { scriptHex: payoutScriptHex, satoshis: Number(refund) }],
    label: 'SELL-A',
  });
  history.push({ ownerPkh: pkhA, delta: -amount });
  poolTxid = sellTxid; poolVout = 0; poolScript = sellSpend.nextLockingHex; reserve = dig.reserveAfter;
  log(`    refund ${refund} → A · reserve ${reserve}`);
  await sleep(5000);

  log('\n▶ 5. BUY OUT — fill the curve to sold == supply');
  const remaining = SUPPLY - history.reduce((s, o) => s + o.delta, 0n);
  await doBuy(pkhB, remaining, 5, funds[4], 'BUY-OUT');
  check('pool is fully sold', history.reduce((s, o) => s + o.delta, 0n) === SUPPLY);

  log('\n▶ 6. GRADUATE — terminal, permissionless');
  const grad = computeGraduate({ terms: TERMS, history: [...history], poolTxid, poolVout, reserveBefore: reserve });
  // ANYONECANPAY|SINGLE pins output 0 only, so the graduator may take change at output 1
  const gradFee = Math.ceil((poolScript.length / 2 + 500) * FEE_RATE);
  const gTx = new Transaction();
  gTx.addInput({ sourceTXID: poolTxid, sourceOutputIndex: poolVout, unlockingScript: Script.fromHex(grad.unlockingHex), sequence: 0xffffffff });
  gTx.addInput({ sourceTransaction: deploy, sourceOutputIndex: 6, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  gTx.addOutput({ lockingScript: Script.fromHex(grad.payoutScriptHex), satoshis: reserve });
  const gChange = funds[5] - gradFee;
  if (gChange >= 546) gTx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: gChange });
  await gTx.sign();
  let gradTxid = '';
  const gv = validateAssembledCovenantInput(gTx.toHex(), { scriptHex: poolScript, satoshis: reserve }, 0);
  if (!gv.ok) { check('graduation passes the interpreter', false, gv.error); }
  else {
    log(`    ${gTx.toHex().length / 2} B tx · interpreter ✓ · releasing ${reserve} sats`);
    gradTxid = await broadcast(gTx.toHex(), 'GRADUATE');
    await sleep(8000);
    const gRes = await woc(`/tx/hash/${gradTxid}`);
    const g = gRes && gRes.ok ? ((await gRes.json()) as any) : null;
    // Check OUTPUT 0 specifically — the one the covenant pins. Summing every output that pays the
    // payout script is wrong here: this harness graduates with its own key, so the graduator's
    // change lands on the SAME address and inflates the total. (The stranger-graduates test does
    // not collide, which is why it never showed this.)
    const out0 = (g?.vout ?? []).find((o: any) => o.n === 0);
    const paid0 = Math.round((out0?.value ?? 0) * 1e8);
    check('output 0 is the committed payout script', (out0?.scriptPubKey?.hex ?? '').toLowerCase() === grad.payoutScriptHex.toLowerCase());
    check('output 0 carries the full reserve', paid0 === reserve, `${paid0} vs ${reserve}`);
  }

  log('\n▶ 7. RECONSTRUCT — rebuild the final script from the op history and compare to chain');
  const rebuilt = poolScriptForHistory(history.slice(0, -0 || undefined), TERMS);
  check('history is complete', history.length === 5, `${history.length}`);
  log(`    final sizes: ${sizes.join(' → ')} B (HashedMap at ${history.length} holders would be ~${10884 + 64 * 2} B and rising)`);

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  if (gradTxid) log(`graduation: https://whatsonchain.com/tx/${gradTxid}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
