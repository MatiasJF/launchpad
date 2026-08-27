/** Throwaway: dump the ADR-030 buy/sell/graduate unlock chunk layout so the reconstruction
 *  parser is grounded in the ACTUAL bytes. Same discipline as the ADR-027 parser. */
import { computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate, buyCost, Op, PoolTerms } from './merkleLedgerState';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const pkhOf = (pub: any) => B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');
const aPriv = B.PrivateKey.fromRandom(), aPub = aPriv.toPublicKey(), aPkh = pkhOf(aPub);
const TERMS: PoolTerms = { k: K, supply: SUPPLY, payoutPkh: pkhOf(B.PrivateKey.fromRandom().toPublicKey()) };

const dump = (label: string, hex: string) => {
  console.log(`\n${label}  (ownerPkh ${aPkh.slice(0, 12)}…):`);
  const chunks = B.Script.fromHex(hex).chunks;
  chunks.forEach((c: any, i: number) => {
    const len = c.buf ? c.buf.length : 0;
    const prev = c.buf ? c.buf.toString('hex').slice(0, 20) : `OP_${c.opcodenum}`;
    console.log(`  [${String(i).padStart(2)}] op=${String(c.opcodenum).padStart(3)} len=${String(len).padStart(6)} ${prev}${len > 10 ? '…' : ''}`);
  });
  console.log(`  (total ${chunks.length} chunks)`);
};

// BUY: A appends (new holder) from an empty pool
const buy = computeBuySpend({ terms: TERMS, history: [], ownerPkh: aPkh, delta: 5n, poolTxid: TXID, poolVout: 0, reserveBefore: 546, newReserve: 546 + Number(buyCost(K, 0n, 5n)) });
dump('BUY (append, isNew=true)', buy.unlockingHex);

// BUY: A updates an existing slot
const h1: Op[] = [{ ownerPkh: aPkh, delta: 5n }];
const r1 = 546 + Number(buyCost(K, 0n, 5n));
const buy2 = computeBuySpend({ terms: TERMS, history: h1, ownerPkh: aPkh, delta: 3n, poolTxid: TXID, poolVout: 0, reserveBefore: r1, newReserve: r1 + Number(buyCost(K, 5n, 3n)) });
dump('BUY (update, isNew=false)', buy2.unlockingHex);

// SELL
const payoutScriptHex = B.Script.buildPublicKeyHashOut(aPub.toAddress()).toHex();
const sellArgs = { terms: TERMS, history: h1, ownerPkh: aPkh, amount: 2n, poolTxid: TXID, poolVout: 0, reserveBefore: r1, payoutScriptHex };
const dig = computeSellDigest(sellArgs);
const der = B.crypto.ECDSA.sign(Buffer.from(dig.digestHex, 'hex'), aPriv).toDER().toString('hex');
dump('SELL', computeSellUnlock({ ...sellArgs, ownerPubHex: aPub.toString(), sigDerHex: der }).unlockingHex);

// GRADUATE
const soldOut: Op[] = [{ ownerPkh: aPkh, delta: SUPPLY }];
dump('GRADUATE', computeGraduate({ terms: TERMS, history: soldOut, poolTxid: TXID, poolVout: 0, reserveBefore: 999 }).unlockingHex);
