import {
  SmartContract,
  prop,
  method,
  assert,
  ByteString,
  hash256,
  SigHash,
} from 'scrypt-ts';

/**
 * LinearCurvePool — the buy-only bonding-curve reserve covenant (Phase 1, ADR-026).
 *
 * A single evolving UTXO: its satoshi balance IS the reserve; its script carries
 * `sold` (tokens sold so far). Immutable params: `k` (price slope) and `supply`
 * (max sellable). Price of the (s+1)-th token = k·(s+1), so the cost to buy `delta`
 * tokens as sold moves s -> s+delta is the exact integer sum:
 *
 *     cost = k · delta · (2s + delta + 1) / 2
 *
 * One of `delta` and `(2s+delta+1)` is always even, so the /2 is EXACT — no lossy
 * division on the enforce path. The covenant never computes a price to hand out;
 * it VERIFIES an inequality (`newReserve >= reserveBefore + cost`) that always
 * resolves in the pool's favour, so truncation can never drain the reserve.
 *
 * Enforcement split (non-custodial): this covenant (input 0, ANYONECANPAY|SINGLE)
 * pins only output 0 = the successor pool with `sold+delta` and value >= reserve+cost.
 * The buyer's own payment input signs ALL, committing their token-receipt output —
 * so the operator can neither mis-price (covenant) nor shortchange delivery (buyer sig).
 */
export class LinearCurvePool extends SmartContract {
  @prop(true)
  sold: bigint;

  @prop()
  readonly k: bigint;

  @prop()
  readonly supply: bigint;

  constructor(sold: bigint, k: bigint, supply: bigint) {
    super(...arguments);
    this.sold = sold;
    this.k = k;
    this.supply = supply;
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public buy(delta: bigint, newReserve: bigint) {
    // must buy a positive amount, and never oversell the curve
    assert(delta > 0n, 'delta must be positive');
    const s: bigint = this.sold;
    assert(s + delta <= this.supply, 'exceeds curve supply');

    // exact integer cost along the linear curve (see class doc)
    const cost: bigint = (this.k * delta * (2n * s + delta + 1n)) / 2n;

    // the buyer must grow the reserve by at least `cost`. reserveBefore is this
    // covenant UTXO's own satoshi value, proven via the pushed preimage (ctx).
    const reserveBefore: bigint = this.ctx.utxo.value;
    assert(newReserve >= reserveBefore + cost, 'underpaid for delta tokens');

    // advance state and require the spending tx re-lock to the successor pool
    this.sold = s + delta;
    const poolOut: ByteString = this.buildStateOutput(newReserve);
    assert(this.ctx.hashOutputs === hash256(poolOut), 'must re-lock to successor pool');
  }
}
