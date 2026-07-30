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
 * Counter — a minimal STATEFUL OP_PUSH_TX covenant.
 *
 * Phase-0 toolchain spike (ADR-026). Proves the exact loop the bonding-curve
 * AMM needs, with none of the curve math:
 *   1. state (`count`) lives in the locking script (a @prop(true) stateful field);
 *   2. spending requires the spender to push this tx's sighash preimage;
 *   3. `checkPreimage` (compiled by scrypt-ts into the "optimal OP_PUSH_TX"
 *      forged-signature construction) proves the pushed bytes ARE this tx;
 *   4. the covenant reconstructs its own next output with `count+1` and asserts
 *      `hashOutputs` matches — i.e. "the next output must re-lock to me, count++".
 *
 * If this compiles to Script and a self-replicating spend confirms on mainnet,
 * the whole covenant approach is validated. If not, we learn it here — cheaply.
 */
export class Counter extends SmartContract {
  @prop(true)
  count: bigint;

  constructor(count: bigint) {
    super(...arguments);
    this.count = count;
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public increment() {
    // mutate state
    this.count++;

    // the covenant's own satoshi balance is preserved into its successor
    const amount: bigint = this.ctx.utxo.value;

    // rebuild THIS contract's next locking output (same script, count now +1)
    const outputs: ByteString = this.buildStateOutput(amount);

    // self-replication constraint: the spending tx's outputs must be exactly
    // the successor covenant. checkPreimage (inside ctx) already proved the
    // preimage — hence hashOutputs — is genuine.
    assert(this.ctx.hashOutputs === hash256(outputs), 'hashOutputs mismatch');
  }
}
