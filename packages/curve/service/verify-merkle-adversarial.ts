/**
 * verify-merkle-adversarial.ts — attack the ADR-030 SCRIPT, not the TypeScript.
 *
 * `verify-merkle-pool.ts` proves honest spends validate, and its negative cases are mostly caught
 * by scrypt-ts simulating the method while BUILDING the unlock. That is a client-side guard, not
 * the covenant, so it proves nothing about what a real attacker can do — an attacker does not use
 * our builder. This suite therefore builds a VALID unlock and then surgically rewrites its bytes:
 * a tampered sibling, a flipped path bit, an inflated balance, a redirected payout. Every case must
 * be rejected by the @bsv/sdk INTERPRETER over the exact assembled transaction.
 *
 * This closes the "the Script itself has not been fuzzed" gap named in
 * `docs/AUDIT-PREP-MERKLE-LEDGER.md`, and targets drain vectors 1-5 directly.
 *
 * Offline, no network, no sats.
 */
import {
  computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate,
  buyCost, Op, PoolTerms,
} from './merkleLedgerState';
import { validateAssembledCovenantInput } from '../src/covenant';
import { Transaction, Script as SdkScript, PrivateKey, P2PKH } from '@bsv/sdk';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const K = 1n;
const SUPPLY = 1000n;
const TXID = 'a'.repeat(64);
const pkhOf = (pub: any) => B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');

const aPriv = B.PrivateKey.fromRandom(), aPub = aPriv.toPublicKey(), aPkh = pkhOf(aPub);
const cPriv = B.PrivateKey.fromRandom(), cPub = cPriv.toPublicKey(), cPkh = pkhOf(cPub);
const evePriv = B.PrivateKey.fromRandom(), evePub = evePriv.toPublicKey(), evePkh = pkhOf(evePub);
const TERMS: PoolTerms = { k: K, supply: SUPPLY, payoutPkh: pkhOf(B.PrivateKey.fromRandom().toPublicKey()) };

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};

// ── surgical unlock rewriting ────────────────────────────────────────────────
// NOTE: mutating a bsv-js `Script.chunks` array does NOT change what `toHex()` emits — the first
// version of this suite did exactly that and every "attack" silently re-ran the HONEST spend,
// producing 20 false alarms. Serialise the chunks ourselves so a tamper is guaranteed to land.
const dataChunk = (buf: Buffer) => ({ buf, len: buf.length, opcodenum: buf.length <= 75 ? buf.length : buf.length <= 0xff ? 76 : buf.length <= 0xffff ? 77 : 78 });
const intChunk = (n: number) => (n === 0 ? { opcodenum: 0 } : n >= 1 && n <= 16 ? { opcodenum: 80 + n } : dataChunk(minimalLE(n)));
function minimalLE(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out.length && (out[out.length - 1] & 0x80)) out.push(0x00);
  return Buffer.from(out.length ? out : [0]);
}

/** Encode one chunk exactly as Bitcoin Script does, preserving the original pushdata form. */
function encodeChunk(c: any): Buffer {
  if (!c.buf) return Buffer.from([c.opcodenum]);
  const b: Buffer = c.buf;
  const op = c.opcodenum;
  if (op < 76) return Buffer.concat([Buffer.from([b.length]), b]);
  if (op === 76) return Buffer.concat([Buffer.from([76, b.length]), b]);
  if (op === 77) { const h = Buffer.alloc(2); h.writeUInt16LE(b.length); return Buffer.concat([Buffer.from([77]), h, b]); }
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  return Buffer.concat([Buffer.from([78]), h, b]);
}
const chunksToHex = (chunks: any[]): string => Buffer.concat(chunks.map(encodeChunk)).toString('hex');

/** Replace one chunk of an unlocking script and re-serialise. Verified to actually change bytes. */
function rewrite(hex: string, index: number, chunk: any): string {
  const chunks = B.Script.fromHex(hex).chunks.slice();
  chunks[index] = chunk;
  const out = chunksToHex(chunks);
  if (out === hex) throw new Error(`tamper at chunk ${index} produced identical bytes — the attack did not land`);
  return out;
}
function chunkAt(hex: string, index: number): any {
  return B.Script.fromHex(hex).chunks[index];
}

/**
 * Assemble the tx and run the interpreter. Returns whether the covenant ACCEPTED it.
 * A throw counts as rejection (a malformed script is not a successful attack).
 */
async function accepted(
  sourceLockHex: string, reserveBefore: number, unlockingHex: string,
  outputs: { scriptHex: string; satoshis: number }[],
): Promise<boolean> {
  try {
    const funder = PrivateKey.fromRandom();
    const parent = new Transaction();
    parent.addOutput({ lockingScript: new P2PKH().lock(funder.toPublicKey().toAddress()), satoshis: 50000 });
    const tx = new Transaction();
    tx.addInput({ sourceTXID: TXID, sourceOutputIndex: 0, unlockingScript: SdkScript.fromHex(unlockingHex), sequence: 0xffffffff });
    tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(funder, 'all', false), sequence: 0xffffffff });
    for (const o of outputs) tx.addOutput({ lockingScript: SdkScript.fromHex(o.scriptHex), satoshis: o.satoshis });
    await tx.sign();
    return validateAssembledCovenantInput(tx.toHex(), { scriptHex: sourceLockHex, satoshis: reserveBefore }, 0).ok;
  } catch {
    return false;
  }
}

/** An attack MUST be rejected. */
async function repelled(name: string, run: () => Promise<boolean>) {
  let ok: boolean;
  try { ok = await run(); } catch { ok = false; }
  check(name, !ok, 'THE COVENANT ACCEPTED THIS ATTACK');
}

// chunk offsets (verified against compiled output, see inspect-merkle-unlock.ts)
const BUY_PATH = 1, BUY_SIB = 17, BUY_ISNEW = 33, BUY_OLDBAL = 34, BUY_DELTA = 35, BUY_NEWRES = 36;
const SELL_PATH = 3, SELL_SIB = 19, SELL_OLDBAL = 35, SELL_AMOUNT = 36, SELL_PAYOUT = 37;

async function main() {
  // ── a pool with three holders, so slots 0/1/2 all exist and can be attacked ──
  const h: Op[] = [
    { ownerPkh: aPkh, delta: 40n },
    { ownerPkh: cPkh, delta: 30n },
    { ownerPkh: evePkh, delta: 10n },
  ];
  let reserve = 546;
  for (let i = 0, s = 0n; i < h.length; i++) { reserve += Number(buyCost(K, s, h[i].delta)); s += h[i].delta; }
  const sold = 80n;

  // a legitimate buy by Eve (updating her own slot 2), used as the tampering base
  const newReserve = reserve + Number(buyCost(K, sold, 5n));
  const buy = computeBuySpend({ terms: TERMS, history: h, ownerPkh: evePkh, delta: 5n, poolTxid: TXID, poolVout: 0, reserveBefore: reserve, newReserve });
  const buyOuts = [{ scriptHex: buy.nextLockingHex, satoshis: newReserve }];
  check('baseline: the honest buy IS accepted', await accepted(buy.sourceLockHex, reserve, buy.unlockingHex, buyOuts));

  console.log('\n=== 1. MERKLE PROOF FORGERY (drain vector 1) ===');
  await repelled('a single tampered sibling byte', async () => {
    const sib = chunkAt(buy.unlockingHex, BUY_SIB + 3);
    const bad = Buffer.from(sib.buf); bad[0] ^= 0xff;
    return accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_SIB + 3, dataChunk(bad)), buyOuts);
  });
  await repelled('a zeroed sibling', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_SIB, dataChunk(Buffer.alloc(32, 0))), buyOuts));
  await repelled('siblings swapped (order matters in the fold)', async () => {
    const s0 = chunkAt(buy.unlockingHex, BUY_SIB), s1 = chunkAt(buy.unlockingHex, BUY_SIB + 1);
    let u = rewrite(buy.unlockingHex, BUY_SIB, s1);
    u = rewrite(u, BUY_SIB + 1, s0);
    return accepted(buy.sourceLockHex, reserve, u, buyOuts);
  });
  await repelled('a short (31-byte) sibling', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_SIB, dataChunk(Buffer.alloc(31, 7))), buyOuts));

  console.log('\n=== 2. PATH / SLOT TARGETING (drain vector 3) ===');
  await repelled('flipping a path bit (addressing a different slot)', async () => {
    const cur = chunkAt(buy.unlockingHex, BUY_PATH);
    const flipped = cur.opcodenum === 81 ? { opcodenum: 0 } : { opcodenum: 81 };
    return accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_PATH, flipped), buyOuts);
  });
  await repelled('claiming another holder\'s slot with your own pkh', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, 0, dataChunk(Buffer.from(aPkh, 'hex'))), buyOuts));

  console.log('\n=== 3. APPEND / UPDATE DISCIPLINE (drain vector 2) ===');
  await repelled('isNew flipped TRUE on an update (would overwrite a live slot)', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_ISNEW, { opcodenum: 81 }), buyOuts));

  // an honest APPEND by a brand-new holder, then flip isNew false
  const newcomer = pkhOf(B.PrivateKey.fromRandom().toPublicKey());
  const appendRes = reserve + Number(buyCost(K, sold, 5n));
  const append = computeBuySpend({ terms: TERMS, history: h, ownerPkh: newcomer, delta: 5n, poolTxid: TXID, poolVout: 0, reserveBefore: reserve, newReserve: appendRes });
  const appendOuts = [{ scriptHex: append.nextLockingHex, satoshis: appendRes }];
  check('baseline: the honest append IS accepted', await accepted(append.sourceLockHex, reserve, append.unlockingHex, appendOuts));
  await repelled('isNew flipped FALSE on an append (claiming an unallocated slot)', async () =>
    accepted(append.sourceLockHex, reserve, rewrite(append.unlockingHex, BUY_ISNEW, { opcodenum: 0 }), appendOuts));

  console.log('\n=== 4. BALANCE / AMOUNT FORGERY ===');
  await repelled('inflated oldBal on a buy', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_OLDBAL, intChunk(9999)), buyOuts));
  await repelled('deflated oldBal on a buy', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_OLDBAL, intChunk(1)), buyOuts));
  await repelled('inflated delta (credit more than the successor records)', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_DELTA, intChunk(500)), buyOuts));
  await repelled('deflated delta', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_DELTA, intChunk(1)), buyOuts));
  await repelled('delta = 0', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_DELTA, intChunk(0)), buyOuts));
  await repelled('newReserve overstated (claim the pool grew more than it did)', async () =>
    accepted(buy.sourceLockHex, reserve, rewrite(buy.unlockingHex, BUY_NEWRES, intChunk(newReserve + 10_000)), buyOuts));

  console.log('\n=== 5. OUTPUT TAMPERING ON BUY (hashOutputs pinning) ===');
  await repelled('successor funded below the required newReserve', async () =>
    accepted(buy.sourceLockHex, reserve, buy.unlockingHex, [{ scriptHex: buy.nextLockingHex, satoshis: newReserve - 1 }]));
  await repelled('successor replaced by a plain P2PKH (steal the reserve)', async () =>
    accepted(buy.sourceLockHex, reserve, buy.unlockingHex, [{ scriptHex: `76a914${evePkh}88ac`, satoshis: newReserve }]));
  await repelled('successor pushed to output 1 (SINGLE pins index 0)', async () =>
    accepted(buy.sourceLockHex, reserve, buy.unlockingHex, [
      { scriptHex: `76a914${evePkh}88ac`, satoshis: 546 },
      { scriptHex: buy.nextLockingHex, satoshis: newReserve },
    ]));

  console.log('\n=== 6. SELL ATTACKS (drain vectors 3-5) ===');
  const payoutScriptHex = B.Script.buildPublicKeyHashOut(cPub.toAddress()).toHex();
  const sellArgs = { terms: TERMS, history: h, ownerPkh: cPkh, amount: 10n, poolTxid: TXID, poolVout: 0, reserveBefore: reserve, payoutScriptHex };
  const dig = computeSellDigest(sellArgs);
  const der = B.crypto.ECDSA.sign(Buffer.from(dig.digestHex, 'hex'), cPriv).toDER().toString('hex');
  const sell = computeSellUnlock({ ...sellArgs, ownerPubHex: cPub.toString(), sigDerHex: der });
  const sellOuts = [
    { scriptHex: sell.nextLockingHex, satoshis: dig.reserveAfter },
    { scriptHex: payoutScriptHex, satoshis: Number(sell.refund) },
  ];
  check('baseline: the honest sell IS accepted', await accepted(sell.sourceLockHex, reserve, sell.unlockingHex, sellOuts));

  await repelled('inflated oldBal on a sell (claim a bigger slot)', async () =>
    accepted(sell.sourceLockHex, reserve, rewrite(sell.unlockingHex, SELL_OLDBAL, intChunk(9999)), sellOuts));
  await repelled('amount raised above the slot balance', async () =>
    accepted(sell.sourceLockHex, reserve, rewrite(sell.unlockingHex, SELL_AMOUNT, intChunk(999)), sellOuts));
  await repelled('tampered sibling on a sell', async () => {
    const sib = chunkAt(sell.unlockingHex, SELL_SIB + 2);
    const bad = Buffer.from(sib.buf); bad[31] ^= 0x01;
    return accepted(sell.sourceLockHex, reserve, rewrite(sell.unlockingHex, SELL_SIB + 2, dataChunk(bad)), sellOuts);
  });
  await repelled('path bit flipped on a sell', async () => {
    const cur = chunkAt(sell.unlockingHex, SELL_PATH);
    const flipped = cur.opcodenum === 81 ? { opcodenum: 0 } : { opcodenum: 81 };
    return accepted(sell.sourceLockHex, reserve, rewrite(sell.unlockingHex, SELL_PATH, flipped), sellOuts);
  });
  await repelled('payout script in the unlock redirected to the attacker', async () =>
    accepted(sell.sourceLockHex, reserve, rewrite(sell.unlockingHex, SELL_PAYOUT, dataChunk(Buffer.from(`76a914${evePkh}88ac`, 'hex'))), sellOuts));
  await repelled('payout OUTPUT redirected to the attacker', async () =>
    accepted(sell.sourceLockHex, reserve, sell.unlockingHex, [
      { scriptHex: sell.nextLockingHex, satoshis: dig.reserveAfter },
      { scriptHex: `76a914${evePkh}88ac`, satoshis: Number(sell.refund) },
    ]));
  await repelled('payout amount inflated beyond the curve refund', async () =>
    accepted(sell.sourceLockHex, reserve, sell.unlockingHex, [
      { scriptHex: sell.nextLockingHex, satoshis: dig.reserveAfter - 500 },
      { scriptHex: payoutScriptHex, satoshis: Number(sell.refund) + 500 },
    ]));
  await repelled('a THIRD output added (ALL pins exactly two)', async () =>
    accepted(sell.sourceLockHex, reserve, sell.unlockingHex, [
      ...sellOuts, { scriptHex: `76a914${evePkh}88ac`, satoshis: 546 },
    ]));
  await repelled('the two sell outputs swapped', async () =>
    accepted(sell.sourceLockHex, reserve, sell.unlockingHex, [sellOuts[1], sellOuts[0]]));
  await repelled('Eve substituting her own pubkey for the slot owner\'s', async () =>
    accepted(sell.sourceLockHex, reserve, rewrite(sell.unlockingHex, 1, dataChunk(Buffer.from(evePub.toString(), 'hex'))), sellOuts));

  console.log('\n=== 7. GRADUATION ATTACKS ===');
  const gHist: Op[] = [{ ownerPkh: aPkh, delta: SUPPLY }];
  const gReserve = 546 + Number(buyCost(K, 0n, SUPPLY));
  const grad = computeGraduate({ terms: TERMS, history: gHist, poolTxid: TXID, poolVout: 0, reserveBefore: gReserve });
  check('baseline: honest graduation IS accepted', await accepted(grad.sourceLockHex, gReserve, grad.unlockingHex, [{ scriptHex: grad.payoutScriptHex, satoshis: gReserve }]));
  await repelled('graduation redirected to the graduator', async () =>
    accepted(grad.sourceLockHex, gReserve, grad.unlockingHex, [{ scriptHex: `76a914${evePkh}88ac`, satoshis: gReserve }]));
  await repelled('graduation skimming the reserve', async () =>
    accepted(grad.sourceLockHex, gReserve, grad.unlockingHex, [
      { scriptHex: grad.payoutScriptHex, satoshis: gReserve - 1000 },
      { scriptHex: `76a914${evePkh}88ac`, satoshis: 1000 },
    ]));
  await repelled('graduation payout demoted to output 1', async () =>
    accepted(grad.sourceLockHex, gReserve, grad.unlockingHex, [
      { scriptHex: `76a914${evePkh}88ac`, satoshis: 546 },
      { scriptHex: grad.payoutScriptHex, satoshis: gReserve },
    ]));

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) console.log('!! a FAILED line above means the covenant ACCEPTED an attack — treat as critical');
  process.exit(fail ? 1 : 0);
}

main();
