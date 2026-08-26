/**
 * merkleLedgerState.ts — state calculator for the MerkleLedgerPool covenant (ADR-030).
 *
 * The ADR-027 equivalent (`ledgerState.ts`) had to REPLAY the pool's entire op history through
 * scrypt-ts on every spend, because a `HashedMap` is insertion-order dependent and only an
 * identically-built instance produces a byte-matching script. That is gone here: this covenant's
 * state is three plain scalars — `sold`, `root`, `holderCount` — so a successor is just those
 * values, and the Merkle root comes from the pure off-chain tree in `src/merkleLedger.ts`.
 *
 * The practical effects: no history replay per spend, and the locking script no longer grows with
 * the holder count. What a spend carries instead is a DEPTH-sibling inclusion proof, constant size.
 */
import { MerkleLedgerPool, DEPTH } from '../src/contracts/merkleLedgerPool';
import { MerkleLedger, replayMerkle, leafHash, EMPTY_LEAF, EMPTY_ROOT } from '../src/merkleLedger';
import { PubKeyHash, PubKey, Sig, toByteString, FixedArray, ByteString, bsv } from 'scrypt-ts';
import artifact from '../artifacts/merkleLedgerPool.json';

let loaded = false;
function ensureLoaded(): void {
  if (!loaded) { (MerkleLedgerPool as any).loadArtifact(artifact as any); loaded = true; }
}

export interface Op { ownerPkh: string; delta: bigint }
export interface PoolTerms { k: bigint; supply: bigint; payoutPkh: string }

const key = (pkh: string) => PubKeyHash(toByteString(pkh));
const bs = (b: Buffer) => toByteString(b.toString('hex'));

/** Path bits for a slot index: bit h set means "our node is the RIGHT child at height h". */
function pathOf(index: number): FixedArray<boolean, 16> {
  const out: boolean[] = [];
  for (let h = 0; h < DEPTH; h++) out.push(((index >> h) & 1) === 1);
  return out as unknown as FixedArray<boolean, 16>;
}

const siblingsOf = (sibs: Buffer[]) => sibs.map(bs) as unknown as FixedArray<ByteString, 16>;

/**
 * Build an instance carrying the given state.
 *
 * CONSTRUCT AT GENESIS, THEN MUTATE — never `new MerkleLedgerPool(sold, root, ...)` directly. A
 * stateful scrypt-ts contract's on-chain (successor) script is produced by mutating a prior
 * instance, and the constructor form serialises differently, so building state directly yields a
 * script that does not byte-match the chain and the covenant's `hashOutputs` check fails. Same
 * trap as ADR-027's replay; cheap here because the state is three scalars, not a HashedMap.
 */
function instance(sold: bigint, root: Buffer, holderCount: bigint, terms: PoolTerms): MerkleLedgerPool {
  ensureLoaded();
  const c = new MerkleLedgerPool(0n, bs(EMPTY_ROOT), 0n, terms.k, terms.supply, key(terms.payoutPkh));
  c.sold = sold;
  c.root = bs(root);
  c.holderCount = holderCount;
  return c;
}

/** The successor script: mutate an independent instance exactly as the covenant does. */
function successorScript(cur: { sold: bigint; root: Buffer; holderCount: bigint }, terms: PoolTerms): string {
  const succ = instance(cur.sold, cur.root, cur.holderCount, terms);
  return String((succ as any).getStateScript());
}

/** The genesis locking script — an empty ledger. Deploy this, funded with the seed reserve. */
export function genesisScript(terms: PoolTerms): string {
  return instance(0n, EMPTY_ROOT, 0n, terms).lockingScript.toHex();
}

/** Rebuild the tree + totals from an ordered op history (the chain-reconstruction entry point). */
export function stateFromHistory(history: Op[]): { ledger: MerkleLedger; sold: bigint; holderCount: bigint } {
  const ledger = replayMerkle(history);
  return { ledger, sold: history.reduce((s, o) => s + o.delta, 0n), holderCount: BigInt(ledger.holderCount) };
}

/** The locking script for a given history — used to assert a byte-match against the chain. */
export function poolScriptForHistory(history: Op[], terms: PoolTerms): string {
  const { ledger, sold, holderCount } = stateFromHistory(history);
  return instance(sold, ledger.root(), holderCount, terms).lockingScript.toHex();
}

export const buyCost = (k: bigint, sold: bigint, delta: bigint) => (k * delta * (2n * sold + delta + 1n)) / 2n;
export const sellRefund = (k: bigint, sold: bigint, amount: bigint) => {
  const ns = sold - amount;
  return (k * amount * (2n * ns + amount + 1n)) / 2n;
};

export interface Spend { unlockingHex: string; sourceLockHex: string; nextLockingHex: string }

/** BUY: credit `delta` to `ownerPkh`, appending a slot if they are new. */
export function computeBuySpend(args: {
  terms: PoolTerms; history: Op[]; ownerPkh: string; delta: bigint;
  poolTxid: string; poolVout: number; reserveBefore: number; newReserve: number;
}): Spend & { cost: bigint } {
  const { terms, history, ownerPkh, delta, poolTxid, poolVout, reserveBefore, newReserve } = args;
  const { ledger, sold, holderCount } = stateFromHistory(history);

  const existing = ledger.indexOf(ownerPkh);
  const isNew = existing === -1;
  const index = isNew ? ledger.holderCount : existing;
  const oldBal = isNew ? 0n : ledger.get(index)!.balance;
  const proof = ledger.proof(index);

  const cur = instance(sold, ledger.root(), holderCount, terms);
  const sourceLockHex = cur.lockingScript.toHex();

  // successor: the new root with this slot rewritten, plus the scalar updates
  const nextLeaf = leafHash(ownerPkh, oldBal + delta);
  const nextRoot = rootFrom(index, nextLeaf, proof.siblings);
  const nextLockingHex = successorScript(
    { sold: sold + delta, root: nextRoot, holderCount: holderCount + (isNew ? 1n : 0n) }, terms);

  const B: any = bsv;
  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: newReserve }));
  (cur as any).to = { tx, inputIndex: 0 };

  const usc = (cur as any).getUnlockingScript((self: any) => {
    self.buy(key(ownerPkh), pathOf(index), siblingsOf(proof.siblings), isNew, oldBal, delta, BigInt(newReserve));
  });
  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex, cost: buyCost(terms.k, sold, delta) };
}

/** Re-derive a root from a rewritten leaf (mirrors the covenant's fold). */
function rootFrom(index: number, leaf: Buffer, siblings: Buffer[]): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rootFromProof } = require('../src/merkleLedger');
  return rootFromProof(index, leaf, siblings);
}

interface SellArgs {
  terms: PoolTerms; history: Op[]; ownerPkh: string; amount: bigint;
  poolTxid: string; poolVout: number; reserveBefore: number; payoutScriptHex: string;
}

function sellParts(args: SellArgs) {
  const { terms, history, ownerPkh, amount, poolTxid, poolVout, reserveBefore, payoutScriptHex } = args;
  const { ledger, sold, holderCount } = stateFromHistory(history);
  const index = ledger.indexOf(ownerPkh);
  if (index === -1) throw new Error('holder has no ledger slot');
  const oldBal = ledger.get(index)!.balance;
  if (amount > oldBal) throw new Error('insufficient balance');

  const proof = ledger.proof(index);
  const cur = instance(sold, ledger.root(), holderCount, terms);
  const sourceLockHex = cur.lockingScript.toHex();

  const refund = sellRefund(terms.k, sold, amount);
  const nextRoot = rootFrom(index, leafHash(ownerPkh, oldBal - amount), proof.siblings);
  const nextLockingHex = successorScript({ sold: sold - amount, root: nextRoot, holderCount }, terms);
  const reserveAfter = reserveBefore - Number(refund);

  const B: any = bsv;
  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(nextLockingHex), satoshis: reserveAfter }));
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: Number(refund) }));
  (cur as any).to = { tx, inputIndex: 0 };

  return { B, cur, tx, index, oldBal, proof, sourceLockHex, nextLockingHex, refund, reserveAfter };
}

/** SELL step 1: the digest the holder signs. */
export function computeSellDigest(args: SellArgs) {
  const { B, tx, sourceLockHex, nextLockingHex, refund, reserveAfter } = sellParts(args);
  const preimage = B.Transaction.sighash.sighashPreimage(tx, 0xc1, 0, B.Script.fromHex(sourceLockHex), new B.crypto.BN(args.reserveBefore));
  const digest = B.crypto.Hash.sha256sha256(preimage);
  return { digestHex: Buffer.from(digest).toString('hex'), sourceLockHex, nextLockingHex, refund, reserveAfter };
}

/** SELL step 2: build the unlock from the holder's DER signature. */
export function computeSellUnlock(args: SellArgs & { ownerPubHex: string; sigDerHex: string }): Spend & { refund: bigint; reserveAfter: number } {
  const { cur, index, oldBal, proof, sourceLockHex, nextLockingHex, refund, reserveAfter } = sellParts(args);
  const sigHex = args.sigDerHex + 'c1';
  const usc = (cur as any).getUnlockingScript((self: any) => {
    self.sell(
      key(args.ownerPkh), PubKey(toByteString(args.ownerPubHex)), Sig(toByteString(sigHex)),
      pathOf(index), siblingsOf(proof.siblings), oldBal, args.amount, toByteString(args.payoutScriptHex),
    );
  });
  return { unlockingHex: usc.toHex(), sourceLockHex, nextLockingHex, refund, reserveAfter };
}

/** GRADUATE (terminal): release the whole reserve to the committed payout. */
export function computeGraduate(args: {
  terms: PoolTerms; history: Op[]; poolTxid: string; poolVout: number; reserveBefore: number;
}): { unlockingHex: string; sourceLockHex: string; payoutScriptHex: string } {
  const { terms, history, poolTxid, poolVout, reserveBefore } = args;
  const { ledger, sold, holderCount } = stateFromHistory(history);
  const B: any = bsv;
  const cur = instance(sold, ledger.root(), holderCount, terms);
  const sourceLockHex = cur.lockingScript.toHex();
  const payoutScriptHex: string = B.Script.buildPublicKeyHashOut(B.Address.fromPublicKeyHash(Buffer.from(terms.payoutPkh, 'hex'))).toHex();

  const tx = new B.Transaction();
  tx.addInput(new B.Transaction.Input({ prevTxId: poolTxid, outputIndex: poolVout, script: new B.Script() }), B.Script.fromHex(sourceLockHex), reserveBefore);
  tx.addOutput(new B.Transaction.Output({ script: B.Script.fromHex(payoutScriptHex), satoshis: reserveBefore }));
  (cur as any).to = { tx, inputIndex: 0 };
  const usc = (cur as any).getUnlockingScript((self: any) => { self.graduate(); });
  return { unlockingHex: usc.toHex(), sourceLockHex, payoutScriptHex };
}

export { EMPTY_LEAF, EMPTY_ROOT, DEPTH };
