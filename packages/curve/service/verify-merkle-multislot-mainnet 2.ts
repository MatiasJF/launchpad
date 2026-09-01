/**
 * verify-merkle-multislot-mainnet.ts — MULTI-SLOT HOLDERS on mainnet (ADR-030).
 *
 * The last gap in `docs/AUDIT-PREP-MERKLE-LEDGER.md` that genuinely needs the chain. ADR-030
 * permits one holder to occupy SEVERAL slots: our client always reuses a holder's first slot, but
 * the covenant does not require that, and an open protocol means other clients exist. The design
 * claims this is harmless — the sum is conserved, so the reserve is unaffected — and that the
 * reconstruction survives it because it replays RECORDED slot indices rather than re-deriving them.
 *
 * Both claims are argued off-chain but were never driven live. This drives them:
 *
 *   deploy → A appends slot 0 → B appends slot 1 → **A appends slot 2 (a SECOND slot for A)**
 *          → A sells from slot 0 → A sells from slot 2 → reconstruct from chain
 *
 * The forced second append is built by hand: our own `computeBuySpend` would reuse slot 0, so the
 * test deliberately does what a third-party client might, which is the entire point.
 *
 * Real sats from the test CLIENT flat key (gitignored `.env`, never printed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import {
  genesisScript, computeSellDigest, computeSellUnlock, poolScriptForSlotOps,
  buyCost, sellRefund, PoolTerms, SlotOp,
} from './merkleLedgerState';
import { MerkleLedgerPool } from '../src/contracts/merkleLedgerPool';
import { MerkleLedger, replayMerkleSlots, leafHash, rootFromProof, DEPTH } from '../src/merkleLedger';
import { resolveMerkleLedgerPool } from './resolveMerkleLedgerPool';
import { validateAssembledCovenantInput } from '../src/covenant';
import { PubKeyHash, PubKey, Sig, toByteString, FixedArray, ByteString, bsv } from 'scrypt-ts';
import artifact from '../artifacts/merkleLedgerPool.json';

const B: any = bsv;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FEE_RATE = 0.01; // ADR-031: measured, see calibrate-fee-rate.ts (10x margin over the lowest mined rate)

const K = 1n;
const SUPPLY = 120n;
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
  throw new Error(`${label} failed: ${lastErr}`);
}

// ── build a buy that targets an EXPLICIT slot, bypassing our client's reuse policy ────────────
let loaded = false;
const bs = (b: Buffer) => toByteString(b.toString('hex'));
const key = (pkh: string) => PubKeyHash(toByteString(pkh));
function instanceAt(sold: bigint, root: Buffer, holderCount: bigint): MerkleLedgerPool {
  if (!loaded) { (MerkleLedgerPool as any).loadArtifact(artifact as any); loaded = true; }
  const c = new MerkleLedgerPool(0n, bs(Buffer.alloc(32)), 0n, TERMS.k, TERMS.supply, key(TERMS.payoutPkh));
  // construct-at-genesis-then-mutate (the successor form; see merkleLedgerState)
  const empty = new MerkleLedger().root();
  const g = new MerkleLedgerPool(0n, bs(empty), 0n, TERMS.k, TERMS.supply, key(TERMS.payoutPkh));
  g.sold = sold; g.root = bs(root); g.holderCount = holderCount;
  return g;
}
const pathOf = (index: number) => {
  const out: boolean[] = [];
  for (let h = 0; h < DEPTH; h++) out.push(((index >> h) & 1) === 1);
  return out as unknown as FixedArray<boolean, 16>;
};
const sibsOf = (s: Buffer[]) => s.map(bs) as unknown as FixedArray<ByteString, 16>;

/** A buy that FORCES an append at `holderCount`, even for a holder who already has a slot. */
function forcedAppendBuy(ops: SlotOp[], ownerPkh: string, delta: bigint, poolTxid: string, poolVout: number, reserveBefore: number, newReserve: number) {
  const led = replayMerkleSlots(ops);
  const sold = ops.reduce((s, o) => s + o.delta, 0n);
  const holderCount = BigInt(led.holderCount);
  const slot = led.holderCount; // the next free slot — an APPEND, not a reuse
  const proof = led.proof(slot);

  const cur = instanceAt(sold, led.root(), holderCount);
  const sourceLockHex = cur.lockingScript.toHex();
  const nextRoot = rootFromProof(slot, leafHash(ownerPkh, delta), proof.siblings);
  const succ = instanceAt(sold + delta, nextRoot, holderCount + 1n);
  const nextLockingHex = String((succ as any).getStateScript());

  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: newReserve }));
  (cur as any).to = { tx, inputIndex: 0 };
  const usc = (cur as any).getUnlockingScript((self: any) => {
    self.buy(key(ownerPkh), pathOf(slot), sibsOf(proof.siblings), true, 0n, delta, BigInt(newReserve));
  });
  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex, slot };
}

async function spend(a: {
  poolTxid: string; poolVout: number; poolScriptHex: string; poolSats: number; unlockingHex: string;
  fundingTx: Transaction; fundingVout: number; outputs: { scriptHex: string; satoshis: number }[]; label: string;
}): Promise<string> {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: a.poolTxid, sourceOutputIndex: a.poolVout, unlockingScript: Script.fromHex(a.unlockingHex), sequence: 0xffffffff });
  tx.addInput({ sourceTransaction: a.fundingTx, sourceOutputIndex: a.fundingVout, unlockingScriptTemplate: unlock(), sequence: 0xffffffff });
  for (const o of a.outputs) tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.satoshis });
  await tx.sign();
  const raw = tx.toHex();
  const v = validateAssembledCovenantInput(raw, { scriptHex: a.poolScriptHex, satoshis: a.poolSats }, 0);
  if (!v.ok) throw new Error(`${a.label} failed the interpreter: ${v.error}`);
  log(`    ${raw.length / 2} B · interpreter ✓`);
  return broadcast(raw, a.label);
}

async function main() {
  log(`wallet: ${address}`);
  log(`terms : k=${K} supply=${SUPPLY} · A ${pkhA.slice(0, 10)}… · B ${pkhB.slice(0, 10)}…`);
  log('\n*** LIVE MAINNET — multi-slot holders (ADR-030) ***\n');

  const gScript = genesisScript(TERMS);
  const fees = 4200;
  // A+20 (210) · B+20 (610) · A+20 AGAIN as a new slot (1010) · sell fee · sell fee
  const funds = [210 + fees, 610 + fees, 1010 + fees, fees, fees];
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
  if (!src) throw new Error(`no verified-unspent UTXO > ${total + 2000} sats`);
  const pHexRes = await woc(`/tx/${src.tx_hash}/hex`);
  const pHex = pHexRes && pHexRes.ok ? (await pHexRes.text()).trim() : null;
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

  const ops: SlotOp[] = [];
  let poolTxid = genesisTxid, poolVout = 0, poolScript = gScript, reserve = SEED;

  const doAppend = async (owner: string, delta: bigint, fv: number, fs2: number, label: string) => {
    const sold = ops.reduce((s, o) => s + o.delta, 0n);
    const cost = buyCost(K, sold, delta);
    const newReserve = reserve + Number(cost);
    const b = forcedAppendBuy(ops, owner, delta, poolTxid, poolVout, reserve, newReserve);
    const change = fs2 - Number(cost) - Math.ceil((b.unlockingHex.length / 2 + b.nextLockingHex.length / 2 + 400) * FEE_RATE);
    const outs = [{ scriptHex: b.nextLockingHex, satoshis: newReserve }];
    if (change >= 546) outs.push({ scriptHex: `76a914${pkhA}88ac`, satoshis: change });
    const txid = await spend({ poolTxid, poolVout, poolScriptHex: poolScript, poolSats: reserve, unlockingHex: b.unlockingHex, fundingTx: deploy, fundingVout: fv, outputs: outs, label });
    ops.push({ ownerPkh: owner, slotIndex: b.slot, delta, isNew: true });
    poolTxid = txid; poolVout = 0; poolScript = b.nextLockingHex; reserve = newReserve;
    log(`    slot ${b.slot} appended for ${owner.slice(0, 10)}… · cost ${cost} · reserve ${reserve}`);
    await sleep(5000);
    return b.slot;
  };

  log('\n▶ 1. A appends slot 0');
  const s0 = await doAppend(pkhA, 20n, 1, funds[0], 'A-SLOT0');
  log('\n▶ 2. B appends slot 1');
  const s1 = await doAppend(pkhB, 20n, 2, funds[1], 'B-SLOT1');
  log('\n▶ 3. A appends a SECOND slot (what our own client would never do)');
  const s2 = await doAppend(pkhA, 20n, 3, funds[2], 'A-SLOT2');

  check('A holds two distinct slots', s0 === 0 && s2 === 2 && s1 === 1, `${s0}/${s1}/${s2}`);
  const led = replayMerkleSlots(ops);
  check('A\'s balance aggregates across both slots', led.balanceOf(pkhA) === 40n, `${led.balanceOf(pkhA)}`);
  check('sold == sum of slots with a duplicate holder', led.total() === 60n, `${led.total()}`);
  check('holderCount counts SLOTS, not holders', led.holderCount === 3, `${led.holderCount}`);

  // ── sell from EACH of A's slots ─────────────────────────────────────────────
  const sellFrom = async (slotIndex: number, amount: bigint, fv: number, label: string) => {
    const sold = ops.reduce((s, o) => s + o.delta, 0n);
    const refund = sellRefund(K, sold, amount);
    const payoutScriptHex = `76a914${pkhA}88ac`;
    // computeSellDigest targets the holder's FIRST slot; for slot 2 we must drive it explicitly,
    // so reuse the same forced path the append used.
    const ledNow = replayMerkleSlots(ops);
    const cur = instanceAt(sold, ledNow.root(), BigInt(ledNow.holderCount));
    const sourceLockHex = cur.lockingScript.toHex();
    const oldBal = ledNow.get(slotIndex)!.balance;
    const proof = ledNow.proof(slotIndex);
    const nextRoot = rootFromProof(slotIndex, leafHash(pkhA, oldBal - amount), proof.siblings);
    const succ = instanceAt(sold - amount, nextRoot, BigInt(ledNow.holderCount));
    const nextLockingHex = String((succ as any).getStateScript());
    const reserveAfter = reserve - Number(refund);

    const btx = new B.Transaction();
    btx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserve);
    btx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: reserveAfter }));
    btx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: Number(refund) }));
    (cur as any).to = { tx: btx, inputIndex: 0 };
    const preimage = B.Transaction.sighash.sighashPreimage(btx, 0xc1, 0, B.Script.fromHex(sourceLockHex), new B.crypto.BN(reserve));
    const digest = B.crypto.Hash.sha256sha256(preimage);
    const der = B.crypto.ECDSA.sign(Buffer.from(digest), B.PrivateKey.fromString(keyHex)).toDER().toString('hex');
    const usc = (cur as any).getUnlockingScript((self: any) => {
      self.sell(key(pkhA), PubKey(toByteString(priv.toPublicKey().toString())), Sig(toByteString(der + 'c1')),
        pathOf(slotIndex), sibsOf(proof.siblings), oldBal, amount, toByteString(payoutScriptHex));
    });
    const txid = await spend({
      poolTxid, poolVout, poolScriptHex: poolScript, poolSats: reserve, unlockingHex: usc.toHex(),
      fundingTx: deploy, fundingVout: fv,
      outputs: [{ scriptHex: nextLockingHex, satoshis: reserveAfter }, { scriptHex: payoutScriptHex, satoshis: Number(refund) }],
      label,
    });
    ops.push({ ownerPkh: pkhA, slotIndex, delta: -amount, isNew: false });
    poolTxid = txid; poolVout = 0; poolScript = nextLockingHex; reserve = reserveAfter;
    log(`    sold ${amount} from slot ${slotIndex} · refund ${refund} · reserve ${reserve}`);
    await sleep(5000);
  };

  log('\n▶ 4. A sells from slot 0');
  await sellFrom(0, 12n, 4, 'SELL-SLOT0');
  log('\n▶ 5. A sells from slot 2 (the duplicate)');
  await sellFrom(2, 10n, 5, 'SELL-SLOT2');

  // ── reconstruct from chain, with no knowledge of the above ──────────────────
  log('\n▶ 6. RECONSTRUCT from chain — does a duplicate-holder ledger survive the walk?');
  const r = await resolveMerkleLedgerPool(genesisTxid, TERMS);
  if ('error' in r) { check('resolve succeeded', false, r.error); }
  else {
    log(`    history : ${r.history.map((o) => `slot${o.slotIndex}${o.isNew ? '*' : ''}${o.delta > 0n ? '+' : ''}${o.delta}`).join(' ')}`);
    log(`    slots   : ${r.slots.map((s) => `[${s.index}] ${s.ownerPkh.slice(0, 8)}…=${s.balance}`).join(' · ')}`);
    check('reconstructed 5 ops', r.history.length === 5, `${r.history.length}`);
    check('reconstruction found THREE slots for two holders', r.holderCount === 3, `${r.holderCount}`);
    check('A appears in two slots on chain', r.slots.filter((s) => s.ownerPkh === pkhA).length === 2);
    check('A balance aggregates correctly (20−12 + 20−10)', r.balances[pkhA] === 18n, `${r.balances[pkhA]}`);
    check('B balance intact', r.balances[pkhB] === 20n, `${r.balances[pkhB]}`);
    check('sold == sum of balances', r.sold === Object.values(r.balances).reduce((a, b) => a + b, 0n));
    check('reserve matches the tracked value', r.reserveSats === reserve, `${r.reserveSats} vs ${reserve}`);
    const expected = poolScriptForSlotOps(ops, TERMS).toLowerCase();
    check('reconstruction BYTE-MATCHES the on-chain tip', r.scriptHex.toLowerCase() === expected);
  }

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  log(`pool: https://whatsonchain.com/tx/${genesisTxid}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
