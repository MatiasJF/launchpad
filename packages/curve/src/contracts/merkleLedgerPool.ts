import {
  SmartContract,
  prop,
  method,
  assert,
  ByteString,
  PubKeyHash,
  PubKey,
  Sig,
  FixedArray,
  hash256,
  hash160,
  sha256,
  toByteString,
  SigHash,
  Utils,
} from 'scrypt-ts';

/**
 * MerkleLedgerPool — the bounded-size trustless bonding curve (ADR-030).
 *
 * Same trust model as ADR-027's `LedgerPool` — holder balances live INSIDE the covenant, so no
 * forgeable token exists and the reserve is drain-proof — but the ledger is committed as a
 * 32-byte Merkle ROOT over a fixed-depth array of holder slots instead of an embedded HashedMap.
 *
 * WHY: the HashedMap put every holder in the locking script, measured at ~64 bytes each, appearing
 * in both the successor script and the sighash preimage — ~128 bytes per holder PER TRADE, and a
 * ~150KB transaction at 1,000 holders. Worse, reconstruction has to download every hop, so a
 * client's verification cost grew as O(trades × holders). Here a spend carries an inclusion proof
 * of exactly DEPTH sibling hashes (512 bytes at DEPTH=16), CONSTANT in holder count.
 *
 * SLOTS ARE INDEXED AND APPEND-ONLY. A key-addressed sparse Merkle tree over a 160-bit pkh would
 * need a 160-level path or a compact bitmap encoding — needless complexity in what is already the
 * largest audit surface in the system. Indexing by slot gives a DEPTH-step verification loop.
 *
 * WHAT THAT REMOVES. `LedgerPool.buy` needed an `isNew` flag backed by a NON-MEMBERSHIP proof,
 * because `HashedMap.set` could otherwise overwrite a live balance and break `sold == sum(slots)`,
 * draining the reserve. Here every spend must prove the CURRENT value of the slot it touches, so
 * nothing can be reset: an update proves `(owner, oldBal)` and a new holder proves the target slot
 * is EMPTY at exactly `holderCount`. A holder ending up with two slots is harmless — the sum is
 * still conserved, which is the property the reserve depends on.
 *
 * The off-chain mirror, its proofs and its invariants live in `src/merkleLedger.ts`
 * (`test/merkle-ledger.test.mjs`), and both sides run the same root computation.
 */
export const DEPTH = 16;
export type MerklePath = FixedArray<boolean, typeof DEPTH>; // true = our node is the RIGHT child
export type MerkleProof = FixedArray<ByteString, typeof DEPTH>;

export class MerkleLedgerPool extends SmartContract {
  @prop(true)
  sold: bigint;

  /** Merkle root over 2^DEPTH holder slots. The entire ledger, in 32 bytes. */
  @prop(true)
  root: ByteString;

  /** Slots allocated so far; the next new holder must land exactly here (append-only). */
  @prop(true)
  holderCount: bigint;

  @prop()
  readonly k: bigint;

  @prop()
  readonly supply: bigint;

  /** Where the reserve is released at graduation (baked in at deploy, immutable). */
  @prop()
  readonly payoutPkh: PubKeyHash;

  constructor(sold: bigint, root: ByteString, holderCount: bigint, k: bigint, supply: bigint, payoutPkh: PubKeyHash) {
    super(...arguments);
    this.sold = sold;
    this.root = root;
    this.holderCount = holderCount;
    this.k = k;
    this.supply = supply;
    this.payoutPkh = payoutPkh;
  }

  /** An unoccupied slot: 32 zero bytes. No real leaf can collide — a leaf is a sha256 image. */
  @method()
  static emptyLeaf(): ByteString {
    return toByteString('0000000000000000000000000000000000000000000000000000000000000000');
  }

  /** Leaf commitment for a slot: sha256(ownerPkh(20) || balance(8, little-endian)). */
  @method()
  static leaf(owner: PubKeyHash, balance: bigint): ByteString {
    return sha256(owner + Utils.toLEUnsigned(balance, 8n));
  }

  /** Fold a leaf up its sibling path to a root — the same walk `rootFromProof` does off-chain. */
  @method()
  static merkleRoot(leaf: ByteString, path: MerklePath, siblings: MerkleProof): ByteString {
    let node: ByteString = leaf;
    for (let h = 0; h < DEPTH; h++) {
      node = path[h] ? sha256(siblings[h] + node) : sha256(node + siblings[h]);
    }
    return node;
  }

  /** The slot index the path addresses: sum of set bits weighted by 2^h. */
  @method()
  static pathIndex(path: MerklePath): bigint {
    let idx: bigint = 0n;
    let p: bigint = 1n;
    for (let h = 0; h < DEPTH; h++) {
      if (path[h]) {
        idx += p;
      }
      p *= 2n;
    }
    return idx;
  }

  /**
   * BUY — keyless. Nobody signs: the covenant prices the credit off the curve and requires the
   * reserve to grow by at least that much, so there is no authority to compromise.
   */
  @method(SigHash.ANYONECANPAY_SINGLE)
  public buy(
    owner: PubKeyHash,
    path: MerklePath,
    siblings: MerkleProof,
    isNew: boolean,
    oldBal: bigint,
    delta: bigint,
    newReserve: bigint,
  ) {
    assert(delta > 0n, 'delta must be positive');
    assert(this.sold + delta <= this.supply, 'exceeds supply');
    const cost: bigint = (this.k * delta * (2n * this.sold + delta + 1n)) / 2n;
    assert(newReserve >= this.ctx.utxo.value + cost, 'underpaid');

    const idx: bigint = MerkleLedgerPool.pathIndex(path);
    if (isNew) {
      // a new holder may only APPEND, and only onto a slot proven empty at this root
      assert(idx == this.holderCount, 'new holder must append at holderCount');
      assert(MerkleLedgerPool.merkleRoot(MerkleLedgerPool.emptyLeaf(), path, siblings) == this.root, 'slot not empty');
      this.root = MerkleLedgerPool.merkleRoot(MerkleLedgerPool.leaf(owner, delta), path, siblings);
      this.holderCount += 1n;
    } else {
      // an existing holder must prove the slot's CURRENT (owner, balance) — so it cannot be reset,
      // nor can one holder's credit be written over another's slot
      assert(idx < this.holderCount, 'slot not allocated');
      assert(MerkleLedgerPool.merkleRoot(MerkleLedgerPool.leaf(owner, oldBal), path, siblings) == this.root, 'ledger proof (buy)');
      this.root = MerkleLedgerPool.merkleRoot(MerkleLedgerPool.leaf(owner, oldBal + delta), path, siblings);
    }
    this.sold += delta;

    const out: ByteString = this.buildStateOutput(newReserve);
    assert(this.ctx.hashOutputs == hash256(out), 're-lock successor pool');
  }

  /**
   * SELL — the holder authorises the debit. That signature IS their claim to the balance; there is
   * no operator co-signature anywhere in this path.
   */
  @method(SigHash.ANYONECANPAY_ALL)
  public sell(
    owner: PubKeyHash,
    ownerPub: PubKey,
    ownerSig: Sig,
    path: MerklePath,
    siblings: MerkleProof,
    oldBal: bigint,
    amount: bigint,
    payoutScript: ByteString,
  ) {
    assert(hash160(ownerPub) == owner, 'pubkey matches owner');
    assert(this.checkSig(ownerSig, ownerPub), 'owner signature');

    assert(amount > 0n, 'amount must be positive');
    assert(oldBal >= amount, 'insufficient balance');
    const idx: bigint = MerkleLedgerPool.pathIndex(path);
    assert(idx < this.holderCount, 'slot not allocated');
    assert(MerkleLedgerPool.merkleRoot(MerkleLedgerPool.leaf(owner, oldBal), path, siblings) == this.root, 'ledger proof (sell)');

    // Refund along the curve. NOTE: this division is EXACT, never a rounding in the pool's favour
    // — d*(2s+d+1) is always even (if d is even so is the product; if d is odd then 2s+d+1 is).
    // So buy and sell are exact inverses and the pool carries NO spread: it is precisely solvent,
    // never over-collateralised, and nothing here discourages wash trading but miner fees.
    // Proven in test/merkle-solvency.test.mjs.
    const newSold: bigint = this.sold - amount;
    const refund: bigint = (this.k * amount * (2n * newSold + amount + 1n)) / 2n;

    this.root = MerkleLedgerPool.merkleRoot(MerkleLedgerPool.leaf(owner, oldBal - amount), path, siblings);
    this.sold = newSold;

    const reserveAfter: bigint = this.ctx.utxo.value - refund;
    const poolOut: ByteString = this.buildStateOutput(reserveAfter);
    const payoutOut: ByteString = Utils.buildOutput(payoutScript, refund);
    assert(this.ctx.hashOutputs == hash256(poolOut + payoutOut), 're-lock + payout');
  }

  /**
   * GRADUATE (terminal, permissionless). Once the curve is fully sold, ANYONE may release the
   * whole reserve to the address committed at deploy. No signature: the destination is fixed, so
   * there is nothing for a hostile graduator to steer.
   */
  @method(SigHash.ANYONECANPAY_SINGLE)
  public graduate() {
    assert(this.sold == this.supply, 'curve not fully sold');
    const payout: ByteString = Utils.buildPublicKeyHashOutput(this.payoutPkh, this.ctx.utxo.value);
    assert(this.ctx.hashOutputs == hash256(payout), 'release reserve to the committed payout');
  }
}
