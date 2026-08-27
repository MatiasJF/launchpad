/**
 * ledgerClient.ts — the OPEN CLIENT for the trustless ledger pool (ADR-027, phase 3).
 *
 * This is the "anyone can build a UI over it" boundary. Everything a client needs to read a pool
 * and trade against it lives here, and it depends on NOTHING of ours: no server actions, no
 * database, no operator API, no privileged key. The only inputs are the pool's genesis outpoint
 * and its immutable public terms (k, supply, payoutPkh); state comes from the blockchain via
 * `resolveLedgerPool`, and the covenant enforces price and custody.
 *
 *   const pool = new LedgerPoolClient(genesisTxid, { k, supply, payoutPkh });
 *   const state = await pool.state();                       // from chain, no DB
 *   const { rawTx } = await pool.buildBuy({ delta: 5n, ownerPkh, funding });
 *   await pool.broadcast(rawTx);
 *
 * WALLET-AGNOSTIC. The client never sees a key. It asks the caller for a funding input plus an
 * @bsv/sdk `UnlockingScriptTemplate` (what `new P2PKH().unlock(priv)` returns, and what a
 * BRC-100 wallet adapter can also implement), and for sells it asks a `Holder` to sign one
 * 32-byte digest. That signature IS the holder's claim to their balance — the covenant checks it.
 *
 * Every build re-resolves the pool from chain and runs the assembled bytes through the @bsv/sdk
 * interpreter before returning, so a client cannot broadcast a spend that the covenant rejects,
 * and cannot build against a stale tip it read earlier.
 *
 * scrypt-ts runs here, so this ships COMPILED (tsc — not esbuild/tsx; a known constraint).
 */
import { Transaction, Script, UnlockingScript } from '@bsv/sdk';
import { computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate, genesisPoolScript, Op } from './ledgerState';
import { validateAssembledCovenantInput } from '../src/covenant';
import { resolveLedgerPool, PoolTerms, ResolvedLedgerPool } from './resolveLedgerPool';

export type { PoolTerms, ResolvedLedgerPool };

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
// Fee rate, sat/byte. MEASURED, not guessed (ADR-031): pool-sized (24.7KB) transactions were
// broadcast at seven descending rates and ALL SEVEN were mined in the same block — including
// 0.001 sat/B, i.e. 25 sats for 24,699 bytes (`service/calibrate-fee-rate.ts`).
//
// We deliberately do NOT set the rate at that floor. It is one sample in one mempool condition, and
// the failure mode is asymmetric: overpaying costs a few hundred satoshis, whereas a pool spend that
// sits unconfirmed eats into the ~25-deep unconfirmed-chain budget that every successor shares. So
// 0.01 keeps a 10x margin over the lowest observed mined rate while still cutting a round trip from
// 7,410 sats to 494 — a 100,000-sat trade pays 0.49% instead of 7.41%.
const DEFAULT_FEE_RATE = 0.01;
const DUST = 546;

/**
 * How the caller signs their own funding input. Structurally identical to what
 * `new P2PKH().unlock(privateKey)` returns, so a flat key works out of the box and a
 * BRC-100 / hardware wallet adapter can implement the same two methods.
 */
export interface UnlockingScriptTemplate {
  sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
  estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
}

/** A funding input the caller supplies: an unspent output plus how to unlock it. */
export interface FundingInput {
  sourceTransaction: Transaction;
  outputIndex: number;
  satoshis: number;
  unlock: UnlockingScriptTemplate;
}

/** The holder authorising a sell. Only a public key and a digest signature are needed. */
export interface Holder {
  ownerPkh: string;
  ownerPubHex: string;
  /** sign a 32-byte digest, returning DER hex WITHOUT the sighash byte */
  signDigest(digestHex: string): Promise<string>;
}

export interface BuiltTx {
  rawTx: string;
  txid: string;
  /** the pool outpoint this spends — a client should re-check it before broadcasting */
  spentPool: { txid: string; vout: number };
}

export interface BuiltBuy extends BuiltTx { cost: bigint; newReserve: number }
export interface BuiltSell extends BuiltTx { refund: bigint; reserveAfter: number; feePaid: number }

/**
 * Did this broadcast fail because the pool outpoint moved under us (someone else's trade landed
 * first), rather than because the transaction is actually invalid? Only the former is retryable.
 * A node reports a vanished input as `txn-mempool-conflict` (a mempool tx already spends it) or
 * `Missing inputs` (already mined/gone); `txn-already-known` means our own tx is in fact in, so
 * treating it as retryable is safe — the next attempt re-resolves and sees it.
 */
function isOutpointConflict(msg: string): boolean {
  return /txn-mempool-conflict|missing inputs|txn-already-known|258:|bad-txns-inputs-missingorspent/i.test(msg);
}

const p2pkhScriptHex = (pkh: string) => `76a914${pkh.toLowerCase()}88ac`;
const toOps = (h: { ownerPkh: string; delta: bigint }[]): Op[] => h.map((o) => ({ ownerPkh: o.ownerPkh, delta: o.delta.toString() }));

/** Curve price of buying `delta` tokens when `sold` are already sold. */
export function buyCost(k: bigint, sold: bigint, delta: bigint): bigint {
  return (k * delta * (2n * sold + delta + 1n)) / 2n;
}

/** Curve refund for selling `amount` tokens when `sold` are sold (rounded against the seller). */
export function sellRefund(k: bigint, sold: bigint, amount: bigint): bigint {
  const newSold = sold - amount;
  return (k * amount * (2n * newSold + amount + 1n)) / 2n;
}

export class LedgerPoolClient {
  readonly genesisTxid: string;
  readonly terms: PoolTerms;
  private readonly genesisVout: number;
  private readonly feeRate: number;

  constructor(genesisTxid: string, terms: PoolTerms, opts: { genesisVout?: number; feeRate?: number } = {}) {
    this.genesisTxid = genesisTxid;
    this.terms = terms;
    this.genesisVout = opts.genesisVout ?? 0;
    this.feeRate = opts.feeRate ?? DEFAULT_FEE_RATE;
  }

  /** The locking script to deploy to OPEN a pool with these terms (fund it with the seed reserve). */
  static genesisScript(terms: PoolTerms): string {
    return genesisPoolScript(terms.k, terms.supply, terms.payoutPkh);
  }

  /** Resolve the pool's current state from the blockchain. No DB, no operator. */
  async state(): Promise<ResolvedLedgerPool> {
    const r = await resolveLedgerPool(this.genesisTxid, this.terms, { genesisVout: this.genesisVout });
    if ('error' in r) throw new Error(`resolve pool: ${r.error}`);
    return r;
  }

  quoteBuy(state: ResolvedLedgerPool, delta: bigint): bigint {
    return buyCost(this.terms.k, state.sold, delta);
  }

  quoteSell(state: ResolvedLedgerPool, amount: bigint): bigint {
    return sellRefund(this.terms.k, state.sold, amount);
  }

  /** A holder's balance as reconstructed from chain. */
  balanceOf(state: ResolvedLedgerPool, ownerPkh: string): bigint {
    return state.balances[ownerPkh.toLowerCase()] ?? 0n;
  }

  /**
   * BUY: credit `delta` tokens to `ownerPkh`, paying the curve price into the reserve.
   *
   * Keyless — no signature authorises the credit; the covenant enforces that the reserve grew by
   * at least the curve cost and that the successor re-locks with the ledger updated. The unlock is
   * ANYONECANPAY|SINGLE, which pins only the successor at output 0, so a change output is fine.
   */
  async buildBuy(args: {
    delta: bigint;
    ownerPkh: string;
    funding: FundingInput;
    /** where buy change goes; defaults to a P2PKH to `ownerPkh` */
    changeScriptHex?: string;
    /** pass a state you already resolved to save a round trip (it is still validated) */
    state?: ResolvedLedgerPool;
  }): Promise<BuiltBuy> {
    const { delta, funding } = args;
    const ownerPkh = args.ownerPkh.toLowerCase();
    const state = args.state ?? (await this.state());
    if (state.graduated) throw new Error('pool has graduated — buying is closed');
    if (delta <= 0n) throw new Error('delta must be positive');
    if (state.sold + delta > this.terms.supply) throw new Error(`exceeds supply (${state.sold} + ${delta} > ${this.terms.supply})`);

    const cost = this.quoteBuy(state, delta);
    const newReserve = state.reserveSats + Number(cost);
    const spend = computeBuySpend({
      k: this.terms.k, supply: this.terms.supply, payoutPkh: this.terms.payoutPkh,
      history: toOps(state.history), ownerPkh, delta,
      poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats, newReserve,
    });

    // Fee is whatever the funding input does not pay into the reserve or return as change.
    const estSize = (spend.unlockingHex.length + spend.nextLockingHex.length) / 2 + 400;
    const fee = Math.ceil(estSize * this.feeRate);
    const change = funding.satoshis - Number(cost) - fee;
    if (change < 0) throw new Error(`funding input ${funding.satoshis} is short: need ${Number(cost) + fee} (cost ${cost} + fee ${fee})`);

    const outputs = [{ scriptHex: spend.nextLockingHex, satoshis: newReserve }];
    if (change >= DUST) outputs.push({ scriptHex: args.changeScriptHex ?? p2pkhScriptHex(ownerPkh), satoshis: change });

    const built = await this.assemble({ state, unlockingHex: spend.unlockingHex, funding, outputs });
    return { ...built, cost, newReserve };
  }

  /**
   * The EXACT satoshi value a sell's fee input must hold.
   *
   * The sell unlock is ANYONECANPAY|ALL and the covenant pins exactly two outputs (successor +
   * payout), so no change output is possible — the whole fee input becomes the miner fee. A
   * seller must therefore pre-size a UTXO to this value (see `buildFeeUtxoTx`). This is a real
   * protocol constraint, not an implementation detail.
   */
  async quoteSellFee(args: { amount: bigint; holder: Pick<Holder, 'ownerPkh'>; state?: ResolvedLedgerPool }): Promise<number> {
    const state = args.state ?? (await this.state());
    const { nextLockingHex } = this.sellShape(state, args.holder.ownerPkh, args.amount);
    // A sell tx is: the unlock (a sighash preimage, dominated by the CURRENT pool script, plus
    // owner/pubkey/sig/payout pushes) + the successor output (the NEXT pool script) + the payout
    // output + envelope. Each pool script is counted exactly once — they are ~equal in size, so
    // double-counting either one inflates the fee by ~50%.
    const unlockSize = state.scriptHex.length / 2 + 300;
    const estSize = unlockSize + nextLockingHex.length / 2 + 400;
    return Math.ceil(estSize * this.feeRate);
  }

  private sellShape(state: ResolvedLedgerPool, ownerPkh: string, amount: bigint) {
    const bal = this.balanceOf(state, ownerPkh);
    if (amount <= 0n) throw new Error('amount must be positive');
    if (amount > bal) throw new Error(`insufficient balance: ${bal} < ${amount}`);
    const refund = this.quoteSell(state, amount);
    if (refund < BigInt(DUST)) throw new Error(`refund ${refund} is below the ${DUST}-sat dust floor — sell more tokens at once`);
    const digest = computeSellDigest({
      k: this.terms.k, supply: this.terms.supply, payoutPkh: this.terms.payoutPkh,
      history: toOps(state.history), ownerPkh, amount,
      poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats,
      payoutScriptHex: p2pkhScriptHex(ownerPkh),
    });
    return { refund, ...digest };
  }

  /**
   * SELL: debit `amount` from the holder's ledger balance and pay them the curve refund.
   *
   * The holder signs one digest — that signature is their claim to the balance, checked inside
   * the covenant (`hash160(ownerPub) == owner && checkSig`). No operator co-signature exists in
   * this path at all: this is what the shipped Option B cannot do.
   */
  async buildSell(args: {
    amount: bigint;
    holder: Holder;
    /** must hold EXACTLY `quoteSellFee()` satoshis — the covenant allows no change output */
    funding: FundingInput;
    /** where the refund is paid; defaults to a P2PKH to the holder */
    payoutScriptHex?: string;
    state?: ResolvedLedgerPool;
  }): Promise<BuiltSell> {
    const { amount, holder, funding } = args;
    const ownerPkh = holder.ownerPkh.toLowerCase();
    const state = args.state ?? (await this.state());
    if (state.graduated) throw new Error('pool has graduated — the ledger is final');

    const payoutScriptHex = args.payoutScriptHex ?? p2pkhScriptHex(ownerPkh);
    const shape = this.sellShape(state, ownerPkh, amount);
    const sellArgs = {
      k: this.terms.k, supply: this.terms.supply, payoutPkh: this.terms.payoutPkh,
      history: toOps(state.history), ownerPkh, amount,
      poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats, payoutScriptHex,
    };
    const digest = computeSellDigest(sellArgs);
    const sigDerHex = await holder.signDigest(digest.digestHex);
    const spend = computeSellUnlock({ ...sellArgs, ownerPubHex: holder.ownerPubHex, sigDerHex });

    // ANYONECANPAY|ALL pins EXACTLY these two outputs — the fee input is consumed whole.
    const outputs = [
      { scriptHex: spend.nextLockingHex, satoshis: digest.reserveAfter },
      { scriptHex: payoutScriptHex, satoshis: Number(spend.refund) },
    ];
    const built = await this.assemble({ state, unlockingHex: spend.unlockingHex, funding, outputs });
    return { ...built, refund: spend.refund, reserveAfter: digest.reserveAfter, feePaid: funding.satoshis };
  }

  /**
   * GRADUATE (terminal, permissionless): once `sold == supply`, anyone may release the whole
   * reserve to the payout address baked in at deploy. No signature — the destination is fixed,
   * so there is nothing to steer and no one to ask.
   */
  async buildGraduate(args: {
    funding: FundingInput;
    /** where the graduator's own change goes; defaults to burning the surplus as fee */
    changeScriptHex?: string;
    state?: ResolvedLedgerPool;
  }): Promise<BuiltTx & { released: number; payoutScriptHex: string }> {
    const state = args.state ?? (await this.state());
    if (state.graduated) throw new Error('pool already graduated');
    if (state.sold !== this.terms.supply) throw new Error(`not fully sold (${state.sold}/${this.terms.supply})`);
    const spend = computeGraduate({
      k: this.terms.k, supply: this.terms.supply, payoutPkh: this.terms.payoutPkh,
      history: toOps(state.history), poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats,
    });

    // Graduation is ANYONECANPAY|SINGLE, so the covenant pins only output 0 (the payout) and the
    // graduator MAY take change at output 1. Without that, triggering a graduation would cost a
    // stranger their entire funding UTXO — a needless disincentive on a permissionless action.
    const outputs = [{ scriptHex: spend.payoutScriptHex, satoshis: state.reserveSats }];
    const estSize = state.scriptHex.length / 2 + 500;
    const fee = Math.ceil(estSize * this.feeRate);
    const change = args.changeScriptHex ? args.funding.satoshis - fee : 0;
    if (args.changeScriptHex && change < 0) throw new Error(`funding ${args.funding.satoshis} is short of the ${fee}-sat fee`);
    if (change >= DUST) outputs.push({ scriptHex: args.changeScriptHex!, satoshis: change });

    const built = await this.assemble({ state, unlockingHex: spend.unlockingHex, funding: args.funding, outputs });
    return { ...built, released: state.reserveSats, payoutScriptHex: spend.payoutScriptHex };
  }

  /** Assemble [pool input (covenant unlock), funding input] -> outputs, and interpreter-check it. */
  private async assemble(args: {
    state: ResolvedLedgerPool;
    unlockingHex: string;
    funding: FundingInput;
    outputs: { scriptHex: string; satoshis: number }[];
  }): Promise<BuiltTx> {
    const { state, funding } = args;
    const tx = new Transaction();
    tx.addInput({ sourceTXID: state.txid, sourceOutputIndex: state.vout, unlockingScript: Script.fromHex(args.unlockingHex), sequence: 0xffffffff });
    tx.addInput({ sourceTransaction: funding.sourceTransaction, sourceOutputIndex: funding.outputIndex, unlockingScriptTemplate: funding.unlock, sequence: 0xffffffff });
    for (const o of args.outputs) tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.satoshis });
    await tx.sign();

    const rawTx = tx.toHex();
    // Refuse to hand back bytes the covenant would reject.
    const v = validateAssembledCovenantInput(rawTx, { scriptHex: state.scriptHex, satoshis: state.reserveSats }, 0);
    if (!v.ok) throw new Error(`covenant input failed the interpreter: ${v.error}`);
    return { rawTx, txid: tx.id('hex') as string, spentPool: { txid: state.txid, vout: state.vout } };
  }

  /**
   * PERMISSIONLESS SEQUENCING — "the loser re-signs" (ADR-027 phase 4).
   *
   * The pool is a single hot UTXO, so two clients that build against the same tip will collide:
   * one lands, the other is rejected because the outpoint it spends no longer exists. There is no
   * operator sequencer to prevent that and none is needed — the loser simply re-resolves the tip,
   * rebuilds, RE-SIGNS, and tries again. Ordering is decided by the network, not by a privileged
   * party, which is what makes the sequencing permissionless.
   *
   * Note the honest consequence: a rebuilt trade is re-priced at the NEW curve position, because
   * the winner moved `sold`. A loser therefore pays more for a buy (or receives less for a sell)
   * than the quote they first saw — the covenant will not honour a stale price. Callers that care
   * should re-quote and confirm rather than blindly retrying; `maxAttempts` bounds the loop.
   *
   * `state` (if given) is used for the FIRST attempt only; every retry re-resolves from chain.
   */
  private async submit<T extends BuiltTx>(
    build: (state: ResolvedLedgerPool) => Promise<T>,
    opts: { state?: ResolvedLedgerPool; maxAttempts?: number } = {},
  ): Promise<T & { txid: string; attempts: number; repriced: boolean }> {
    const maxAttempts = opts.maxAttempts ?? 4;
    let state = opts.state;
    let lastErr = '';
    const firstTip = state ? `${state.txid}:${state.vout}` : '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const s = state ?? (await this.state());
      state = undefined; // only the caller's state seeds attempt 1; retries always re-resolve
      const built = await build(s);
      try {
        const txid = await this.broadcast(built.rawTx);
        return { ...built, txid, attempts: attempt, repriced: !!firstTip && `${s.txid}:${s.vout}` !== firstTip };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!isOutpointConflict(lastErr)) throw e; // a real failure, not a race — surface it
        // someone else moved the pool between our read and our broadcast: re-resolve and re-sign
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
    throw new Error(`lost the sequencing race ${maxAttempts}x (last: ${lastErr})`);
  }

  /** BUY, retrying through contention. See `submit`. */
  async submitBuy(args: Parameters<LedgerPoolClient['buildBuy']>[0] & { maxAttempts?: number }) {
    return this.submit((state) => this.buildBuy({ ...args, state }), { state: args.state, maxAttempts: args.maxAttempts });
  }

  /** SELL, retrying through contention — the holder re-signs each rebuilt attempt. See `submit`. */
  async submitSell(args: Parameters<LedgerPoolClient['buildSell']>[0] & { maxAttempts?: number }) {
    return this.submit((state) => this.buildSell({ ...args, state }), { state: args.state, maxAttempts: args.maxAttempts });
  }

  /** Broadcast, retrying transient failures. Returns the txid. */
  async broadcast(rawTx: string): Promise<string> {
    let lastErr = '';
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${WOC}/tx/raw`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }),
        });
        const body = (await res.text()).trim();
        if (res.ok) return body.replace(/"/g, '');
        lastErr = body;
        // A definitive rejection will not improve on retry — surface it now.
        if (res.status !== 429 && !/rate|limit|timeout|50[023]/i.test(body)) break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    throw new Error(`broadcast failed: ${lastErr}`);
  }
}
