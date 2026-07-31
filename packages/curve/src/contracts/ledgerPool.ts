import {
  SmartContract,
  prop,
  method,
  assert,
  ByteString,
  PubKeyHash,
  PubKey,
  Sig,
  hash256,
  hash160,
  HashedMap,
  SigHash,
  Utils,
} from 'scrypt-ts';

/**
 * LedgerPool — feasibility spike for the trustless sell-back pool (ADR-027).
 *
 * Holder balances live INSIDE the covenant as a HashedMap (ownerPkh -> amount),
 * so no independent, forgeable token UTXO exists. A buy credits the ledger; a sell
 * debits it (owner authorises with a signature) and pays the curve refund. The
 * pool's `sold` can only move by amounts bound to a real ledger entry — the reserve
 * is drain-proof with no indexer and no platform key.
 *
 * This spike only proves the toolchain (HashedMap as stateful @prop + buy/sell
 * shapes compile to Script). Curve-math exactness + adversarial tests come next.
 */
export type Ledger = HashedMap<PubKeyHash, bigint>;

export class LedgerPool extends SmartContract {
  @prop(true)
  sold: bigint;

  @prop(true)
  ledger: Ledger;

  @prop()
  readonly k: bigint;

  @prop()
  readonly supply: bigint;

  // Where the reserve is released at graduation (baked in at deploy, immutable).
  @prop()
  readonly payoutPkh: PubKeyHash;

  constructor(sold: bigint, ledger: Ledger, k: bigint, supply: bigint, payoutPkh: PubKeyHash) {
    super(...arguments);
    this.sold = sold;
    this.ledger = ledger;
    this.k = k;
    this.supply = supply;
    this.payoutPkh = payoutPkh;
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public buy(owner: PubKeyHash, isNew: boolean, oldBal: bigint, delta: bigint, newReserve: bigint) {
    assert(delta > 0n, 'delta must be positive');
    assert(this.sold + delta <= this.supply, 'exceeds supply');
    const cost: bigint = (this.k * delta * (2n * this.sold + delta + 1n)) / 2n;
    assert(newReserve >= this.ctx.utxo.value + cost, 'underpaid');

    // credit the ledger. A first-time buyer has no entry: prove NON-membership so
    // `oldBal` can't be spoofed to overwrite/reset an existing balance (which would
    // break the sold == sum(balances) invariant). An existing buyer proves their
    // current balance, then we increment it.
    if (isNew) {
      assert(!this.ledger.has(owner), 'holder already exists');
      this.ledger.set(owner, delta);
    } else {
      assert(this.ledger.canGet(owner, oldBal), 'ledger proof (buy)');
      this.ledger.set(owner, oldBal + delta);
    }
    this.sold += delta;

    const out: ByteString = this.buildStateOutput(newReserve);
    assert(this.ctx.hashOutputs === hash256(out), 're-lock successor pool');
  }

  @method(SigHash.ANYONECANPAY_ALL)
  public sell(
    owner: PubKeyHash,
    ownerPub: PubKey,
    ownerSig: Sig,
    oldBal: bigint,
    amount: bigint,
    payoutScript: ByteString,
  ) {
    // the holder authorises the sell (this IS their claim to the balance)
    assert(hash160(ownerPub) === owner, 'pubkey matches owner');
    assert(this.checkSig(ownerSig, ownerPub), 'owner signature');

    assert(amount > 0n, 'amount must be positive');
    assert(oldBal >= amount, 'insufficient balance');
    assert(this.ledger.canGet(owner, oldBal), 'ledger proof (sell)');

    // refund along the curve, rounded against the seller (pool keeps more)
    const newSold: bigint = this.sold - amount;
    const refund: bigint = (this.k * amount * (2n * newSold + amount + 1n)) / 2n;

    this.ledger.set(owner, oldBal - amount);
    this.sold = newSold;

    const reserveAfter: bigint = this.ctx.utxo.value - refund;
    const poolOut: ByteString = this.buildStateOutput(reserveAfter);
    // pay the refund to the seller's payout script
    const payoutOut: ByteString = Utils.buildOutput(payoutScript, refund);
    assert(this.ctx.hashOutputs === hash256(poolOut + payoutOut), 're-lock + payout');
  }

  /**
   * Graduation (terminal). Once the curve is fully sold, anyone may spend the pool to
   * release the whole reserve to the pre-committed payout address — the pool does NOT
   * re-lock (the curve is over). Real STAS is then minted to holders off-chain from the
   * final ledger (which is public and immutable at this point). No signature: the
   * destination is fixed at deploy, so there is nothing to steer.
   */
  @method(SigHash.ANYONECANPAY_SINGLE)
  public graduate() {
    assert(this.sold === this.supply, 'curve not fully sold');
    const payout: ByteString = Utils.buildPublicKeyHashOutput(this.payoutPkh, this.ctx.utxo.value);
    assert(this.ctx.hashOutputs === hash256(payout), 'must release reserve to payout');
  }
}
