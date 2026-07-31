/**
 * ledgerState.ts — SERVER-SIDE state calculator for the LedgerPool covenant (ADR-027).
 *
 * scrypt-ts is used ONLY here, as a pure computation (no Signer/Provider, no network):
 * given the pool's ordered operation HISTORY, it replays the ledger to reconstruct the
 * exact on-chain instance, then emits the pool-input unlock (via getUnlockingScript,
 * which injects the HashedMap access path) + the successor script. @bsv/sdk assembles
 * and re-verifies the real transaction.
 *
 * WHY HISTORY, NOT FLAT BALANCES: scrypt-ts's HashedMap is insertion-history-dependent,
 * and a stateful contract's on-chain script (successor form) is produced by the covenant
 * mutating a CLONE of the previous instance. Reconstructing from a flat balance list gives
 * a different script (genesis form / different map order) and the covenant's checkPreimage
 * fails. So we replay every prior buy/sell (clone-then-set from genesis) to land on an
 * instance whose lockingScript byte-matches the on-chain UTXO, and build the successor by
 * mutating a replayed instance the same way the covenant does. Proven against a real
 * mainnet successor UTXO.
 */
import { LedgerPool, Ledger } from '../src/contracts/ledgerPool';
import { HashedMap, PubKeyHash, PubKey, Sig, toByteString, bsv } from 'scrypt-ts';
import artifact from '../artifacts/ledgerPool.json';

let loaded = false;
function ensureLoaded(): void {
  if (!loaded) { (LedgerPool as any).loadArtifact(artifact as any); loaded = true; }
}

/** One prior pool operation: a buy (delta > 0) or a sell (delta < 0) by a holder. */
export interface Op { ownerPkh: string; delta: string }

const key = (pkh: string) => PubKeyHash(toByteString(pkh));

/**
 * Replay the history to the current pool instance by DIRECT in-place mutation from
 * genesis — the same way the covenant produces each successor (mutate, then
 * getStateScript). A per-op clone-then-new-instance replay instead embeds the prior
 * ledger inline as a constructor arg (genesis form), which only matches the on-chain
 * script when the base ledger is empty (the first op) — so it breaks on the 2nd spend.
 * Proven against the real mainnet successors 04f87f04:0 and ca6692f6:0.
 */
function replay(history: Op[], k: bigint, supply: bigint): LedgerPool {
  ensureLoaded();
  const cur = new LedgerPool(0n, new HashedMap<PubKeyHash, bigint>(), k, supply);
  cur.sold = 0n;
  const bal = new Map<string, bigint>();
  for (const op of history) {
    const d = BigInt(op.delta);
    const id = op.ownerPkh.toLowerCase();
    const nb = (bal.get(id) ?? 0n) + d;
    bal.set(id, nb);
    cur.ledger.set(key(op.ownerPkh), nb);
    cur.sold = cur.sold + d;
  }
  return cur;
}

function balanceOf(history: Op[], ownerPkh: string): bigint {
  const id = ownerPkh.toLowerCase();
  return history.reduce((s, op) => (op.ownerPkh.toLowerCase() === id ? s + BigInt(op.delta) : s), 0n);
}

/** The genesis pool locking script (empty history) — deployed to open a pool. */
export function genesisPoolScript(k: bigint, supply: bigint): string {
  return replay([], k, supply).lockingScript.toHex();
}

export interface BuySpend { unlockingHex: string; sourceLockHex: string; nextLockingHex: string }

/** Build the pool-input unlock for a BUY crediting `ownerPkh` by `delta` (ANYONECANPAY|SINGLE). */
export function computeBuySpend(args: {
  k: bigint; supply: bigint; history: Op[]; ownerPkh: string; delta: bigint;
  poolTxid: string; poolVout: number; reserveBefore: number; newReserve: number;
}): BuySpend {
  const { k, supply, history, ownerPkh, delta, poolTxid, poolVout, reserveBefore, newReserve } = args;
  const oldBal = balanceOf(history, ownerPkh);
  const isNew = oldBal === 0n;

  const cur = replay(history, k, supply);
  const sourceLockHex = cur.lockingScript.toHex();

  // successor: mutate an independent replayed instance exactly as the covenant does
  const succ = replay(history, k, supply);
  succ.ledger.set(key(ownerPkh), oldBal + delta);
  succ.sold = succ.sold + delta;
  const nextLockingHex = String((succ as any).getStateScript());

  const B: any = bsv;
  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: newReserve }));
  (cur as any).to = { tx, inputIndex: 0 };

  const usc = (cur as any).getUnlockingScript((self: any) => { self.buy(key(ownerPkh), isNew, oldBal, delta, BigInt(newReserve)); });
  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex };
}

interface SellArgs {
  k: bigint; supply: bigint; history: Op[]; ownerPkh: string; amount: bigint;
  poolTxid: string; poolVout: number; reserveBefore: number; payoutScriptHex: string;
}

function buildSellTx(args: SellArgs) {
  const { k, supply, history, ownerPkh, amount, poolTxid, poolVout, reserveBefore, payoutScriptHex } = args;
  const oldBal = balanceOf(history, ownerPkh);
  if (amount > oldBal) throw new Error('insufficient balance');
  const B: any = bsv;

  const cur = replay(history, k, supply);
  const sourceLockHex = cur.lockingScript.toHex();

  const succ = replay(history, k, supply);
  succ.ledger.set(key(ownerPkh), oldBal - amount);
  succ.sold = succ.sold - amount;
  const nextLockingHex = String((succ as any).getStateScript());

  const newSold = cur.sold - amount;
  const refund = (k * amount * (2n * newSold + amount + 1n)) / 2n;
  const reserveAfter = reserveBefore - Number(refund);

  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: reserveAfter }));
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: Number(refund) }));
  (cur as any).to = { tx, inputIndex: 0 };

  return { B, cur, tx, oldBal, sourceLockHex, nextLockingHex, reserveAfter, refund };
}

export interface SellDigest {
  digestHex: string; sourceLockHex: string; nextLockingHex: string; payoutScriptHex: string; refund: bigint; reserveAfter: number;
}

/** SELL step 1: the digest the holder must sign, plus successor + payout info. */
export function computeSellDigest(args: SellArgs): SellDigest {
  const { B, tx, sourceLockHex, nextLockingHex, reserveAfter, refund } = buildSellTx(args);
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc1, 0, B.Script.fromHex(sourceLockHex), new B.crypto.BN(args.reserveBefore));
  const digest = B.crypto.Hash.sha256sha256(preimage);
  return { digestHex: Buffer.from(digest).toString('hex'), sourceLockHex, nextLockingHex, payoutScriptHex: args.payoutScriptHex, refund, reserveAfter };
}

export interface SellSpend { unlockingHex: string; sourceLockHex: string; nextLockingHex: string; payoutScriptHex: string; refund: bigint }

/** SELL step 2: build the unlock from the holder's DER signature (no sighash byte). */
export function computeSellUnlock(args: SellArgs & { ownerPubHex: string; sigDerHex: string }): SellSpend {
  const { cur, oldBal, sourceLockHex, nextLockingHex, refund } = buildSellTx(args);
  const sigHex = args.sigDerHex + 'c1';
  const usc = (cur as any).getUnlockingScript((self: any) => {
    self.sell(key(args.ownerPkh), PubKey(toByteString(args.ownerPubHex)), Sig(toByteString(sigHex)), oldBal, args.amount, toByteString(args.payoutScriptHex));
  });
  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex, payoutScriptHex: args.payoutScriptHex, refund };
}

/** Convenience one-shot (tests): digest -> signHash -> unlock. */
export function computeSellSpend(args: SellArgs & { ownerPubHex: string; signHash: (digestHex: string) => string }): SellSpend {
  const d = computeSellDigest(args);
  return computeSellUnlock({ ...args, sigDerHex: args.signHash(d.digestHex) });
}
