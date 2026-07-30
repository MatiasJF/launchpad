/**
 * ledgerState.ts — SERVER-SIDE state calculator for the LedgerPool covenant (ADR-027).
 *
 * scrypt-ts is used ONLY here, as a pure computation over the ledger (no Signer/
 * Provider, no network): given the current balances + the one holder being changed,
 * it emits the HashedMap access-path proof and the successor pool locking script.
 * @bsv/sdk then assembles + verifies the actual transaction (the pool unlock is
 * `<args> <preimage> <accessPath>`; the preimage is computed client-side over the
 * real tx, so nothing here depends on the spending tx).
 *
 * The three serialization-consistency disciplines the runtime spike found the hard
 * way are baked in: build the current map FRESH from balances, build the successor
 * as a clone-then-`.set()` (never fresh-with-final-values), and construct instances
 * with sold=0n then ASSIGN so state encodings match the on-chain form.
 */
import { LedgerPool, Ledger } from '../src/contracts/ledgerPool';
import { HashedMap, PubKeyHash, toByteString, bsv } from 'scrypt-ts';
import artifact from '../artifacts/ledgerPool.json';

let loaded = false;
function ensureLoaded(): void {
  if (!loaded) {
    (LedgerPool as any).loadArtifact(artifact as any);
    loaded = true;
  }
}

export interface Balance {
  ownerPkh: string; // 20-byte hex (hash160 of compressed pubkey)
  amount: bigint;
}

/** Build a fresh HashedMap ledger from the current balances. */
function mkLedger(balances: Balance[]): Ledger {
  const m = new HashedMap<PubKeyHash, bigint>();
  for (const b of balances) m.set(PubKeyHash(toByteString(b.ownerPkh)), b.amount);
  return m;
}

function poolWith(sold: bigint, ledger: Ledger, k: bigint, supply: bigint): LedgerPool {
  const p = new LedgerPool(0n, ledger, k, supply); // sold=0n then assign (gotcha)
  p.sold = sold;
  return p;
}

/** The current pool locking script for a given (sold, balances). */
export function poolScript(args: { sold: bigint; k: bigint; supply: bigint; balances: Balance[] }): string {
  ensureLoaded();
  return String((poolWith(args.sold, mkLedger(args.balances), args.k, args.supply) as any).getStateScript());
}

/** The genesis pool locking script (sold=0, empty ledger) — deployed to open a pool. */
export function genesisPoolScript(k: bigint, supply: bigint): string {
  ensureLoaded();
  return poolWith(0n, mkLedger([]), k, supply).lockingScript.toHex();
}

export interface BuyCalldata {
  isNew: boolean;
  oldBal: bigint;
  accessPathHex: string;
  nextLockingHex: string; // successor pool script (state = sold+delta, ledger credited)
}

export interface BuySpend {
  unlockingHex: string; // full pool-input unlock (args + preimage + access path)
  sourceLockHex: string; // current pool script (what the input spends)
  nextLockingHex: string; // successor pool output script
}

/**
 * Build the full pool-input unlocking script for a BUY via scrypt-ts (which injects
 * the correct arg encodings + HashedMap access path). ANYONECANPAY|SINGLE, so the
 * preimage depends only on output 0 (the successor) + this input — the caller can
 * add the buyer's payment input afterwards without invalidating it.
 */
export function computeBuySpend(args: {
  sold: bigint; k: bigint; supply: bigint; balances: Balance[];
  ownerPkh: string; delta: bigint;
  poolTxid: string; poolVout: number; reserveBefore: number; newReserve: number;
}): BuySpend {
  ensureLoaded();
  const { sold, k, supply, balances, ownerPkh, delta, poolTxid, poolVout, reserveBefore, newReserve } = args;
  const key = PubKeyHash(toByteString(ownerPkh));
  const existing = balances.find((b) => b.ownerPkh.toLowerCase() === ownerPkh.toLowerCase());
  const isNew = !existing;
  const oldBal = existing ? existing.amount : 0n;

  const cur = poolWith(sold, mkLedger(balances), k, supply);
  const sourceLockHex: string = cur.lockingScript.toHex();

  // successor: CLONE cur's actual map object (preserving its internal order), then
  // apply the one change — exactly mirroring the covenant's in-place `set`. A fresh
  // mkLedger with final values orders entries differently and the re-lock fails.
  const clone: Ledger = new HashedMap<PubKeyHash, bigint>(cur.ledger as any);
  const next = poolWith(sold + delta, clone, k, supply);
  next.ledger.set(key, oldBal + delta);
  const nextLockingHex: string = String((next as any).getStateScript());

  const B: any = bsv;
  const tx = new B.Transaction();
  tx.addInput(
    new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }),
    B.Script.fromHex(sourceLockHex),
    reserveBefore,
  );
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: newReserve }));
  (cur as any).to = { tx, inputIndex: 0 };

  const usc = (cur as any).getUnlockingScript((self: any) => {
    self.buy(key, isNew, oldBal, delta, BigInt(newReserve));
  });

  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex };
}

/** Compute the ledger proof + successor script for a BUY crediting `owner` by `delta`. */
export function computeBuyCalldata(args: {
  sold: bigint; k: bigint; supply: bigint;
  balances: Balance[]; ownerPkh: string; delta: bigint;
}): BuyCalldata {
  ensureLoaded();
  const { sold, k, supply, balances, ownerPkh, delta } = args;
  const key = PubKeyHash(toByteString(ownerPkh));
  const existing = balances.find((b) => b.ownerPkh.toLowerCase() === ownerPkh.toLowerCase());
  const isNew = !existing;
  const oldBal = existing ? existing.amount : 0n;

  // current map (fresh) — trace the exact ops the covenant runs to get the path
  const cur = poolWith(sold, mkLedger(balances), k, supply);
  const led: any = cur.ledger;
  led.startTracing();
  if (isNew) {
    led.has(key);
    led.set(key, delta);
  } else {
    led.canGet(key, oldBal);
    led.set(key, oldBal + delta);
  }
  led.stopTracing();
  const accessPathHex: string = led.serializedAccessPath();

  // successor: clone-then-set (rebuild current fresh, then apply the one change)
  const nextLedger = mkLedger(balances);
  nextLedger.set(key, oldBal + delta);
  const next = poolWith(sold + delta, nextLedger, k, supply);
  const nextLockingHex: string = String((next as any).getStateScript());

  return { isNew, oldBal, accessPathHex, nextLockingHex };
}

export interface SellSpend {
  unlockingHex: string;
  sourceLockHex: string;
  nextLockingHex: string;
  payoutScriptHex: string;
  refund: bigint;
}

/**
 * Build the pool-input unlock for a SELL. ANYONECANPAY|ALL, so the preimage pins
 * BOTH outputs (successor pool + seller payout) but not other inputs — the caller
 * adds a fee input afterwards. The holder authorises with `signHash`, which signs
 * the standard sighash (in production this is the wallet's createSignature; here a
 * local key). The returned sig is DER + the sighash-type byte (0xc1).
 */
interface SellArgs {
  sold: bigint; k: bigint; supply: bigint; balances: Balance[];
  ownerPkh: string; amount: bigint;
  poolTxid: string; poolVout: number; reserveBefore: number; payoutScriptHex: string;
}

/** Shared, DETERMINISTIC sell-tx builder so digest (step 1) and unlock (step 2) agree. */
function buildSellTx(args: SellArgs) {
  ensureLoaded();
  const { sold, k, supply, balances, ownerPkh, amount, poolTxid, poolVout, reserveBefore, payoutScriptHex } = args;
  const B: any = bsv;
  const key = PubKeyHash(toByteString(ownerPkh));
  const existing = balances.find((b) => b.ownerPkh.toLowerCase() === ownerPkh.toLowerCase());
  if (!existing) throw new Error('seller has no ledger balance');
  const oldBal = existing.amount;
  if (amount > oldBal) throw new Error('insufficient balance');

  const newSold = sold - amount;
  const refund = (k * amount * (2n * newSold + amount + 1n)) / 2n;

  const cur = poolWith(sold, mkLedger(balances), k, supply);
  const sourceLockHex: string = cur.lockingScript.toHex();
  const clone: Ledger = new HashedMap<PubKeyHash, bigint>(cur.ledger as any);
  const next = poolWith(newSold, clone, k, supply);
  next.ledger.set(key, oldBal - amount);
  const nextLockingHex: string = String((next as any).getStateScript());

  const reserveAfter = reserveBefore - Number(refund);
  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: reserveAfter }));
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: Number(refund) }));
  (cur as any).to = { tx, inputIndex: 0 };

  return { B, cur, tx, key, oldBal, sourceLockHex, nextLockingHex, reserveAfter, refund };
}

export interface SellDigest {
  digestHex: string; // sha256sha256(sighashPreimage) — what the holder's wallet signs
  sourceLockHex: string; nextLockingHex: string; payoutScriptHex: string;
  refund: bigint; reserveAfter: number;
}

/** SELL step 1: the digest the holder must sign, plus the successor + payout info. */
export function computeSellDigest(args: SellArgs): SellDigest {
  const { B, tx, sourceLockHex, nextLockingHex, reserveAfter, refund } = buildSellTx(args);
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc1, 0, B.Script.fromHex(sourceLockHex), new B.crypto.BN(args.reserveBefore));
  const digest = B.crypto.Hash.sha256sha256(preimage);
  return { digestHex: Buffer.from(digest).toString('hex'), sourceLockHex, nextLockingHex, payoutScriptHex: args.payoutScriptHex, refund, reserveAfter };
}

/** SELL step 2: build the unlock from the holder's signature (DER, no sighash byte). */
export function computeSellUnlock(args: SellArgs & { ownerPubHex: string; sigDerHex: string }): SellSpend {
  const { cur, key, oldBal, sourceLockHex, nextLockingHex, refund } = buildSellTx(args);
  const sigHex = args.sigDerHex + 'c1'; // DER + sighash-type byte
  const { Sig, PubKey } = require('scrypt-ts');
  const usc = (cur as any).getUnlockingScript((self: any) => {
    self.sell(key, PubKey(toByteString(args.ownerPubHex)), Sig(toByteString(sigHex)), oldBal, args.amount, toByteString(args.payoutScriptHex));
  });
  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex, payoutScriptHex: args.payoutScriptHex, refund };
}

/** Convenience one-shot (tests): digest -> signHash -> unlock. */
export function computeSellSpend(args: SellArgs & { ownerPubHex: string; signHash: (digestHex: string) => string }): SellSpend {
  const d = computeSellDigest(args);
  const sigDerHex = args.signHash(d.digestHex);
  return computeSellUnlock({ ...args, sigDerHex });
}

export interface SellCalldata {
  oldBal: bigint;
  accessPathHex: string;
  nextLockingHex: string; // successor pool script (state = sold-amount, ledger debited)
  refund: bigint;
}

/** Compute the ledger proof + successor + refund for a SELL debiting `owner` by `amount`. */
export function computeSellCalldata(args: {
  sold: bigint; k: bigint; supply: bigint;
  balances: Balance[]; ownerPkh: string; amount: bigint;
}): SellCalldata {
  ensureLoaded();
  const { sold, k, supply, balances, ownerPkh, amount } = args;
  const key = PubKeyHash(toByteString(ownerPkh));
  const existing = balances.find((b) => b.ownerPkh.toLowerCase() === ownerPkh.toLowerCase());
  if (!existing) throw new Error('seller has no ledger balance');
  const oldBal = existing.amount;
  if (amount > oldBal) throw new Error('insufficient balance');

  const cur = poolWith(sold, mkLedger(balances), k, supply);
  const led: any = cur.ledger;
  led.startTracing();
  led.canGet(key, oldBal);
  led.set(key, oldBal - amount);
  led.stopTracing();
  const accessPathHex: string = led.serializedAccessPath();

  const nextLedger = mkLedger(balances);
  nextLedger.set(key, oldBal - amount);
  const newSold = sold - amount;
  const next = poolWith(newSold, nextLedger, k, supply);
  const nextLockingHex: string = String((next as any).getStateScript());

  // refund mirrors the covenant: k*amount*(2*newSold+amount+1)/2 (exact)
  const refund = (k * amount * (2n * newSold + amount + 1n)) / 2n;

  return { oldBal, accessPathHex, nextLockingHex, refund };
}
