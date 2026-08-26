/**
 * verify-reconstruct.ts — offline proof of the trustless linchpin (ADR-027 ledger track).
 *
 * Builds a real op sequence (buys + sells) with the SAME code paths the app uses, collects
 * each hop's on-chain unlocking script, then reconstructs the ledger FROM THOSE SCRIPTS ALONE
 * (no DB) and asserts:
 *   1. parseLedgerOp extracts (ownerPkh, delta) exactly, per hop.
 *   2. reconstructHistoryFromUnlocks reproduces the full intended history.
 *   3. replay(reconstructed).lockingScript BYTE-MATCHES the actual on-chain successor (tip).
 *   4. a genesis→tip chain-walk (injected fetcher) reproduces history + tip outpoint.
 *
 * No network: the "chain" is synthesised from the real unlock scripts. Once (3)/(4) pass, the
 * operator's database is non-authoritative — a client can rebuild pool state from chain.
 */
import { computeBuySpend, computeSellDigest, computeSellUnlock, poolScriptForHistory, Op } from './ledgerState';
import {
  parseLedgerOp,
  reconstructHistoryFromUnlocks,
  reconstructLedgerHistory,
  WalkTx,
} from '../src/ledgerReconstruct';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const k = 1n;
const supply = 1000n;
const cost = (sold: bigint, d: bigint) => (k * d * (2n * sold + d + 1n)) / 2n;
const pkhOf = (pub: any) => B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');

const payoutPkh = pkhOf(B.PrivateKey.fromRandom().toPublicKey());
const A = B.PrivateKey.fromRandom();
const C = B.PrivateKey.fromRandom();
const aPub = A.toPublicKey();
const cPub = C.toPublicKey();
const aPkh = pkhOf(aPub);
const cPkh = pkhOf(cPub);

const GENESIS = 'f'.repeat(64);

interface Intended { ownerPkh: string; delta: bigint }
const intended: Intended[] = [];
const history: Op[] = [];
const unlocks: string[] = [];
const chain: WalkTx[] = []; // synthetic successor txs; input-0 carries the real unlock
let reserve = 546;
let sold = 0n;
let curTxid = GENESIS;
let curVout = 0;
let hopN = 0;
const nextTxid = () => String(hopN++).padStart(2, '0') + 'e'.repeat(62);

function pushHop(unlockHex: string, poolVout: number) {
  const txid = nextTxid();
  chain.push({ txid, inputUnlockHex: [unlockHex], poolVout });
  curTxid = txid;
  curVout = poolVout;
}

function buy(pkh: string, delta: bigint): string {
  const newReserve = reserve + Number(cost(sold, delta));
  const r = computeBuySpend({
    k, supply, payoutPkh, history: [...history], ownerPkh: pkh, delta,
    poolTxid: curTxid, poolVout: curVout, reserveBefore: reserve, newReserve,
  });
  unlocks.push(r.unlockingHex);
  pushHop(r.unlockingHex, 0);
  intended.push({ ownerPkh: pkh.toLowerCase(), delta });
  history.push({ ownerPkh: pkh, delta: delta.toString() });
  reserve = newReserve;
  sold += delta;
  return r.nextLockingHex;
}

function sell(priv: any, pub: any, pkh: string, amount: bigint): string {
  const payoutScriptHex = B.Script.buildPublicKeyHashOut(pub.toAddress()).toHex();
  const args = {
    k, supply, payoutPkh, history: [...history], ownerPkh: pkh, amount,
    poolTxid: curTxid, poolVout: curVout, reserveBefore: reserve, payoutScriptHex,
  };
  const dig = computeSellDigest(args);
  const der = B.crypto.ECDSA.sign(Buffer.from(dig.digestHex, 'hex'), priv).toDER().toString('hex');
  const r = computeSellUnlock({ ...args, ownerPubHex: pub.toString(), sigDerHex: der });
  unlocks.push(r.unlockingHex);
  pushHop(r.unlockingHex, 0);
  intended.push({ ownerPkh: pkh.toLowerCase(), delta: -amount });
  history.push({ ownerPkh: pkh, delta: (-amount).toString() });
  reserve = dig.reserveAfter;
  sold -= amount;
  return r.nextLockingHex;
}

// Op sequence exercising: first buy, second holder, a sell, a repeat-buyer, a sell to zero.
buy(aPkh, 5n);
buy(cPkh, 3n);
sell(A, aPub, aPkh, 2n);
buy(aPkh, 1n);
const tip = sell(C, cPub, cPkh, 1n);

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x = '') => {
  if (c) { pass++; console.log('  [PASS]', n); }
  else { fail++; console.log('  [FAIL]', n, x); }
};

async function main() {
  console.log('=== 1. parseLedgerOp extracts (ownerPkh, delta) per hop ===');
  for (let i = 0; i < unlocks.length; i++) {
    const got = parseLedgerOp(unlocks[i]);
    const want = intended[i];
    check(`hop ${i} ownerPkh`, !!got && got.ownerPkh === want.ownerPkh, `${got?.ownerPkh} vs ${want.ownerPkh}`);
    check(`hop ${i} delta`, !!got && got.delta === want.delta, `${got?.delta} vs ${want.delta}`);
  }

  console.log('\n=== 2. reconstructHistoryFromUnlocks matches intended history ===');
  const recon = reconstructHistoryFromUnlocks(unlocks);
  check('op count', recon.length === intended.length, `${recon.length} vs ${intended.length}`);
  check('every op matches', recon.every((o, i) => o.ownerPkh === intended[i].ownerPkh && o.delta === intended[i].delta));

  console.log('\n=== 3. replay(reconstructed) byte-matches the on-chain tip successor ===');
  const reconHistory: Op[] = recon.map((o) => ({ ownerPkh: o.ownerPkh, delta: o.delta.toString() }));
  const rebuilt = poolScriptForHistory(reconHistory, k, supply, payoutPkh);
  check('reconstructed lockingScript == tip', rebuilt === tip, `${rebuilt.slice(0, 40)}… vs ${tip.slice(0, 40)}…`);

  console.log('\n=== 4. genesis→tip chain-walk reproduces history + tip outpoint ===');
  const spendMap = new Map<string, WalkTx>();
  let prevTxid = GENESIS;
  let prevVout = 0;
  for (const w of chain) {
    spendMap.set(`${prevTxid}:${prevVout}`, w);
    prevTxid = w.txid;
    prevVout = w.poolVout;
  }
  const fetchSpendOf = async (txid: string, vout: number) => spendMap.get(`${txid}:${vout}`) ?? null;
  const walked = await reconstructLedgerHistory(GENESIS, 0, fetchSpendOf);
  check('walk op count', walked.history.length === intended.length, `${walked.history.length} vs ${intended.length}`);
  check('walk ops match', walked.history.every((o, i) => o.ownerPkh === intended[i].ownerPkh && o.delta === intended[i].delta));
  check('walk tip outpoint', walked.tipTxid === prevTxid && walked.tipVout === 0, `${walked.tipTxid.slice(0, 10)}:${walked.tipVout}`);
  const walkedRebuilt = poolScriptForHistory(
    walked.history.map((o) => ({ ownerPkh: o.ownerPkh, delta: o.delta.toString() })),
    k, supply, payoutPkh,
  );
  check('walk reconstructed == tip', walkedRebuilt === tip);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main();
