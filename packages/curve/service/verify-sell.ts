/**
 * verify-sell.ts — proves the SELL pool-input unlock (with a holder signature)
 * validates in @bsv/sdk's interpreter, and that over-debit / bad-sig are rejected.
 * Signs with a local key the way the wallet would (sha256sha256(preimage)). No network.
 */
import { Spend, LockingScript, UnlockingScript } from '@bsv/sdk';
import { computeSellSpend } from './ledgerState';
import { bsv } from 'scrypt-ts';

const B: any = bsv;
const K = 1n, SUPPLY = 1000n;
const TXID = 'a'.repeat(64);

// a local holder identity
const priv = B.PrivateKey.fromRandom();
const pub = priv.toPublicKey();
const ownerPubHex: string = pub.toString(); // compressed hex
const ownerPkh: string = B.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex');
const payoutScriptHex: string = B.Script.buildPublicKeyHashOut(pub.toAddress()).toHex();

function signWith(p: any) {
  return (digestHex: string): string => {
    const sig = B.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p);
    return sig.toDER().toString('hex');
  };
}

const curveCost = (k: bigint, sold: bigint, amount: bigint): bigint => (k * amount * (2n * sold + amount + 1n)) / 2n;

function trySell(o: { sold: bigint; balances: any[]; amount: bigint; reserveBefore: number; signer?: any; pubHex?: string }): { ok: boolean; error?: string } {
  let sp;
  try {
    sp = computeSellSpend({
      sold: o.sold, k: K, supply: SUPPLY, balances: o.balances,
      ownerPkh, ownerPubHex: o.pubHex ?? ownerPubHex, amount: o.amount,
      poolTxid: TXID, poolVout: 0, reserveBefore: o.reserveBefore,
      payoutScriptHex, signHash: signWith(o.signer ?? priv),
    });
  } catch (e: any) { return { ok: false, error: 'service: ' + e.message }; }

  const refund = Number(sp.refund);
  const outputs = [
    { satoshis: o.reserveBefore - refund, lockingScript: LockingScript.fromHex(sp.nextLockingHex) },
    { satoshis: refund, lockingScript: LockingScript.fromHex(sp.payoutScriptHex) },
  ];
  const spend = new Spend({
    sourceTXID: TXID, sourceOutputIndex: 0, sourceSatoshis: o.reserveBefore,
    lockingScript: LockingScript.fromHex(sp.sourceLockHex), transactionVersion: 1,
    otherInputs: [], outputs, inputIndex: 0,
    unlockingScript: UnlockingScript.fromHex(sp.unlockingHex), inputSequence: 0xffffffff, lockTime: 0,
  } as any);
  try { return { ok: spend.validate() }; }
  catch (e: any) { return { ok: false, error: String(e.message).split('\n')[0] }; }
}

let pass = 0, fail = 0;
const check = (n: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log('[PASS]', n); } else { fail++; console.log('[FAIL]', n, extra); } };

// holder has 10 tokens (sold=10), sells 4. reserve seeded above the curve total.
const bal = [{ ownerPkh, amount: 10n }];
const reserve = 546 + Number(curveCost(K, 0n, 10n)); // reserve after 10 were bought

const r1 = trySell({ sold: 10n, balances: bal, amount: 4n, reserveBefore: reserve });
check('valid sell (holder signs, debit 4) validates', r1.ok, r1.error);

const r2 = trySell({ sold: 10n, balances: bal, amount: 20n, reserveBefore: reserve });
check('over-debit (amount > balance) rejected', r2.ok === false, r2.error);

// bad signature: sign with a DIFFERENT key but claim the real owner
const wrong = B.PrivateKey.fromRandom();
const r3 = trySell({ sold: 10n, balances: bal, amount: 4n, reserveBefore: reserve, signer: wrong });
check('bad signature rejected', r3.ok === false, r3.error);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
