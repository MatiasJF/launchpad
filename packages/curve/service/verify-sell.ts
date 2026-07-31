/**
 * verify-sell.ts — SELL: the holder-signed pool unlock validates in @bsv/sdk, and
 * over-debit / bad-sig are rejected. Signs the digest with a local key the way the
 * wallet would. History-replay reconstruction. No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeSellSpend, type Op } from './ledgerState';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const K = 1n, SUPPLY = 1000n, TXID = 'a'.repeat(64);
const curveCost = (sold: bigint, a: bigint): bigint => (K * a * (2n * sold + a + 1n)) / 2n;

const priv = B.PrivateKey.fromRandom();
const pub = priv.toPublicKey();
const ownerPubHex: string = pub.toString();
const ownerPkh: string = B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');
const payoutScriptHex: string = B.Script.buildPublicKeyHashOut(pub.toAddress()).toHex();
const signWith = (p: any) => (digestHex: string): string => B.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p).toDER().toString('hex');

function trySell(o: { history: Op[]; amount: bigint; reserveBefore: number; signer?: any }): { ok: boolean; error?: string } {
  let sp;
  try {
    sp = computeSellSpend({ k: K, supply: SUPPLY, history: o.history, ownerPkh, ownerPubHex, amount: o.amount, poolTxid: TXID, poolVout: 0, reserveBefore: o.reserveBefore, payoutScriptHex, signHash: signWith(o.signer ?? priv) });
  } catch (e: any) { return { ok: false, error: 'service: ' + e.message }; }
  const refund = Number(sp.refund);
  const outputs = [
    { satoshis: o.reserveBefore - refund, lockingScript: LockingScript.fromHex(sp.nextLockingHex) },
    { satoshis: refund, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) },
  ];
  const spend = new Spend({ sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: o.reserveBefore, lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1, otherInputs: [], outputs, inputIndex: 0, unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0 } as any);
  try { return { ok: spend.validate() }; } catch (e: any) { return { ok: false, error: String(e.message).split('\n')[0] }; }
}

const history: Op[] = [{ ownerPkh, delta: '10' }];
const reserve = 546 + Number(curveCost(0n, 10n));
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { if (c) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, x); } };

check('valid sell (holder signs, debit 4) validates', trySell({ history, amount: 4n, reserveBefore: reserve }).ok);
check('over-debit (amount > balance) rejected', trySell({ history, amount: 20n, reserveBefore: reserve }).ok === false);
check('bad signature rejected', trySell({ history, amount: 4n, reserveBefore: reserve, signer: B.PrivateKey.fromRandom() }).ok === false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
