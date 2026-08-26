/**
 * merkleLedger.ts — the bounded-size holder ledger (ADR-030, Limit A).
 *
 * WHY THIS EXISTS. The ADR-027 ledger keeps every holder inside the covenant as a `HashedMap`, so
 * the locking script grows with the holder count — measured at ~64 bytes per holder, and it lands
 * in BOTH the successor script and the sighash preimage, so ~128 bytes per holder PER TRADE
 * (`service/measure-ledger-size.ts`). At 1,000 holders that is a ~150KB transaction for a single
 * buy. The fee is survivable; the real cost is that reconstruction must download every hop, so a
 * client's cost to verify the pool grows as O(trades × holders).
 *
 * WHAT REPLACES IT. A fixed-depth Merkle tree over an APPEND-ONLY array of holder slots. The
 * covenant stores only the 32-byte root plus `holderCount`; a spend carries an inclusion proof of
 * exactly DEPTH sibling hashes (512 bytes at DEPTH=16), CONSTANT in holder count.
 *
 * WHY AN INDEXED APPEND-ONLY TREE, NOT A KEY-ADDRESSED SMT. A sparse Merkle tree keyed by a
 * 160-bit pkh needs a 160-level path (~5KB proofs) or a compact bitmap encoding that is markedly
 * harder to verify in Script — the largest audit surface in the system is the wrong place to be
 * clever. Addressing leaves by INDEX gives a DEPTH-level proof and a verification loop that is
 * DEPTH plain sha256 steps.
 *
 * WHY DUPLICATE HOLDERS ARE SAFE HERE. The HashedMap design needed an `isNew` flag plus a
 * non-membership proof, because `set(owner, ...)` could otherwise OVERWRITE an existing balance and
 * break `sold == sum(balances)`. Indexed slots remove that vector by construction: a spend must
 * prove the CURRENT value of the leaf it touches, so nothing can be reset. The worst a duplicate
 * insert achieves is the same holder owning two slots, and the sum is still conserved.
 *
 * Pure and dependency-free (node crypto only) so the open client, the state service, and the
 * contract's test vectors all share one implementation.
 */
import { createHash } from 'node:crypto';

/** Tree depth: 2^16 = 65,536 holder slots, proof = 16 × 32 = 512 bytes. */
export const DEPTH = 16;
export const MAX_HOLDERS = 2 ** DEPTH;

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();

/** An unoccupied slot. Distinct from any real leaf: a real leaf is a sha256 image. */
export const EMPTY_LEAF: Buffer = Buffer.alloc(32, 0);

/**
 * Leaf commitment for a holder slot: sha256(pkh(20) || balance(8, little-endian)).
 * Balance is fixed-width so no length ambiguity can make two different (pkh, balance) pairs
 * serialise identically.
 */
export function leafHash(ownerPkh: string, balance: bigint): Buffer {
  const pkh = Buffer.from(ownerPkh.toLowerCase(), 'hex');
  if (pkh.length !== 20) throw new Error(`ownerPkh must be 20 bytes, got ${pkh.length}`);
  if (balance < 0n) throw new Error('balance must be non-negative');
  if (balance > 0xffffffffffffffffn) throw new Error('balance exceeds 8 bytes');
  const bal = Buffer.alloc(8);
  bal.writeBigUInt64LE(balance);
  return sha256(Buffer.concat([pkh, bal]));
}

/** Roots of fully-empty subtrees, indexed by height (0 = a leaf). Precomputed once. */
export const EMPTY_ROOTS: Buffer[] = (() => {
  const out = [EMPTY_LEAF];
  for (let h = 1; h <= DEPTH; h++) out.push(sha256(Buffer.concat([out[h - 1], out[h - 1]])));
  return out;
})();

export const EMPTY_ROOT: Buffer = EMPTY_ROOTS[DEPTH];

/**
 * Recompute a root from a leaf and its sibling path — the exact computation the covenant runs.
 * `siblings[h]` is the sibling at height h (0 = leaf level). Bit h of `index` selects the side:
 * 0 = our node is on the left.
 */
export function rootFromProof(index: number, leaf: Buffer, siblings: Buffer[]): Buffer {
  if (siblings.length !== DEPTH) throw new Error(`proof must have ${DEPTH} siblings, got ${siblings.length}`);
  let node = leaf;
  for (let h = 0; h < DEPTH; h++) {
    const right = (index >> h) & 1;
    node = right ? sha256(Buffer.concat([siblings[h], node])) : sha256(Buffer.concat([node, siblings[h]]));
  }
  return node;
}

export interface HolderSlot { ownerPkh: string; balance: bigint }
export interface InclusionProof { index: number; leaf: Buffer; siblings: Buffer[] }

/**
 * The off-chain mirror of the covenant's tree. Holds only occupied slots — an empty subtree is
 * never materialised — so a pool with a handful of holders costs a handful of nodes, not 2^16.
 */
export class MerkleLedger {
  /** slot index -> holder. Append-only: indices are handed out in order. */
  private readonly slots = new Map<number, HolderSlot>();
  private cache = new Map<string, Buffer>();

  /** Number of slots ever allocated — the next append lands here. Mirrors covenant state. */
  get holderCount(): number {
    return this.slots.size === 0 ? 0 : Math.max(...this.slots.keys()) + 1;
  }

  private invalidate(): void {
    this.cache = new Map();
  }

  /** Root of the subtree at (height, index), short-circuiting on empty regions. */
  private subtree(height: number, index: number): Buffer {
    if (height === 0) {
      const s = this.slots.get(index);
      return s ? leafHash(s.ownerPkh, s.balance) : EMPTY_LEAF;
    }
    const key = `${height}:${index}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    // if no occupied slot falls inside this subtree, it is the precomputed empty root
    const span = 2 ** height;
    const lo = index * span;
    const hi = lo + span;
    let occupied = false;
    for (const i of this.slots.keys()) if (i >= lo && i < hi) { occupied = true; break; }
    const out = occupied
      ? sha256(Buffer.concat([this.subtree(height - 1, index * 2), this.subtree(height - 1, index * 2 + 1)]))
      : EMPTY_ROOTS[height];
    this.cache.set(key, out);
    return out;
  }

  root(): Buffer {
    return this.subtree(DEPTH, 0);
  }

  get(index: number): HolderSlot | undefined {
    return this.slots.get(index);
  }

  /** First slot held by `ownerPkh`, or -1. A holder may legitimately occupy several. */
  indexOf(ownerPkh: string): number {
    const want = ownerPkh.toLowerCase();
    for (const [i, s] of this.slots) if (s.ownerPkh.toLowerCase() === want) return i;
    return -1;
  }

  /** Total across all slots — the invariant the covenant maintains against `sold`. */
  total(): bigint {
    let t = 0n;
    for (const s of this.slots.values()) t += s.balance;
    return t;
  }

  balanceOf(ownerPkh: string): bigint {
    const want = ownerPkh.toLowerCase();
    let t = 0n;
    for (const s of this.slots.values()) if (s.ownerPkh.toLowerCase() === want) t += s.balance;
    return t;
  }

  /** Inclusion proof for a slot (occupied or not — an empty slot proves non-membership). */
  proof(index: number): InclusionProof {
    if (index < 0 || index >= MAX_HOLDERS) throw new Error(`index ${index} out of range`);
    const siblings: Buffer[] = [];
    for (let h = 0; h < DEPTH; h++) {
      const sibIndex = (index >> h) ^ 1;
      siblings.push(this.subtree(h, sibIndex));
    }
    const s = this.slots.get(index);
    return { index, leaf: s ? leafHash(s.ownerPkh, s.balance) : EMPTY_LEAF, siblings };
  }

  /** Append a new holder at the next free slot. Returns the slot index. */
  insert(ownerPkh: string, balance: bigint): number {
    const index = this.holderCount;
    if (index >= MAX_HOLDERS) throw new Error(`ledger is full (${MAX_HOLDERS} slots)`);
    this.slots.set(index, { ownerPkh: ownerPkh.toLowerCase(), balance });
    this.invalidate();
    return index;
  }

  /** Set an existing slot's balance. The covenant equivalent proves the old value first. */
  update(index: number, balance: bigint): void {
    const s = this.slots.get(index);
    if (!s) throw new Error(`slot ${index} is empty`);
    if (balance < 0n) throw new Error('balance must be non-negative');
    this.slots.set(index, { ownerPkh: s.ownerPkh, balance });
    this.invalidate();
  }

  /** Every occupied slot, in index order. */
  entries(): (HolderSlot & { index: number })[] {
    return [...this.slots.entries()].sort((a, b) => a[0] - b[0]).map(([index, s]) => ({ index, ...s }));
  }

  /** Balances aggregated per holder (a holder may hold several slots). */
  balances(): Record<string, bigint> {
    const out: Record<string, bigint> = {};
    for (const s of this.slots.values()) out[s.ownerPkh] = (out[s.ownerPkh] ?? 0n) + s.balance;
    for (const k of Object.keys(out)) if (out[k] === 0n) delete out[k];
    return out;
  }
}

/**
 * Rebuild the ledger from an ordered op history — the SMT counterpart of `ledgerState.replay()`,
 * and what lets a client reconstruct the tree from chain alone. A buy credits the holder's first
 * slot (appending one if they are new); a sell debits it.
 */
export function replayMerkle(history: { ownerPkh: string; delta: bigint }[]): MerkleLedger {
  const led = new MerkleLedger();
  for (const op of history) {
    const i = led.indexOf(op.ownerPkh);
    if (i === -1) {
      if (op.delta < 0n) throw new Error(`sell by unknown holder ${op.ownerPkh.slice(0, 10)}…`);
      led.insert(op.ownerPkh, op.delta);
    } else {
      const cur = led.get(i)!.balance;
      const next = cur + op.delta;
      if (next < 0n) throw new Error(`holder ${op.ownerPkh.slice(0, 10)}… oversold (${cur} ${op.delta})`);
      led.update(i, next);
    }
  }
  return led;
}
