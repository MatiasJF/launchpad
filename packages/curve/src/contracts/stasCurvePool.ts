import {
  SmartContract,
  prop,
  method,
  assert,
  ByteString,
  PubKey,
  PubKeyHash,
  Sig,
  hash256,
  hash160,
  SigHash,
  Utils,
} from 'scrypt-ts';

/**
 * StasCurvePool — the reserve covenant for the Option-B hybrid curve (ADR-028).
 *
 * Holds ONLY the sats reserve + `sold` (the wallet-held tokens are real STAS, not a
 * ledger). Small and size-stable (no HashedMap). The curve price is `k·(s+1)`, so the
 * exact integer cost to move `sold` by delta is `k·delta·(2·sold + delta + 1)/2`
 * (verify-invariant, rounds for the pool — never drainable below the curve).
 *
 *   BUY  (open): anyone pays sats in; reserve += cost, sold += delta. No key — buying
 *        is always safe. The STAS delivery to the buyer rides in the same tx (other
 *        outputs), enforced by the buyer's own SIGHASH_ALL payment signature.
 *   SELL (gated): pays the curve refund to the seller AND requires an OPERATOR
 *        signature. The covenant caps the payout at the curve refund, so the operator
 *        can authorise or refuse but can NEVER overpay or redirect — the gate only
 *        exists to reject forged-STAS sells (authenticity isn't in-script checkable).
 */
export class StasCurvePool extends SmartContract {
  @prop(true)
  sold: bigint;

  @prop()
  readonly k: bigint;

  @prop()
  readonly supply: bigint;

  // The operator key that must co-sign sells (the anti-forgery gate).
  @prop()
  readonly operatorPkh: PubKeyHash;

  constructor(sold: bigint, k: bigint, supply: bigint, operatorPkh: PubKeyHash) {
    super(...arguments);
    this.sold = sold;
    this.k = k;
    this.supply = supply;
    this.operatorPkh = operatorPkh;
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public buy(delta: bigint, newReserve: bigint) {
    assert(delta > 0n, 'delta must be positive');
    assert(this.sold + delta <= this.supply, 'exceeds supply');
    const cost: bigint = (this.k * delta * (2n * this.sold + delta + 1n)) / 2n;
    assert(newReserve >= this.ctx.utxo.value + cost, 'underpaid');

    this.sold += delta;
    const out: ByteString = this.buildStateOutput(newReserve);
    assert(this.ctx.hashOutputs === hash256(out), 're-lock successor pool');
  }

  @method(SigHash.ANYONECANPAY_ALL)
  public sell(delta: bigint, payoutScript: ByteString, operatorPub: PubKey, operatorSig: Sig) {
    // operator gate — authorises the sell after verifying the returned STAS is genuine
    assert(hash160(operatorPub) === this.operatorPkh, 'wrong operator key');
    assert(this.checkSig(operatorSig, operatorPub), 'operator signature');

    assert(delta > 0n, 'delta must be positive');
    assert(delta <= this.sold, 'sells more than outstanding');

    const newSold: bigint = this.sold - delta;
    const refund: bigint = (this.k * delta * (2n * newSold + delta + 1n)) / 2n;
    this.sold = newSold;

    const reserveAfter: bigint = this.ctx.utxo.value - refund;
    const poolOut: ByteString = this.buildStateOutput(reserveAfter);
    const payoutOut: ByteString = Utils.buildOutput(payoutScript, refund);
    assert(this.ctx.hashOutputs === hash256(poolOut + payoutOut), 're-lock + payout');
  }
}
