/**
 * merkleLedgerClient.ts — the OPEN CLIENT for the bounded-size pool (ADR-030).
 *
 * Same contract with the outside world as `ledgerClient.ts` (ADR-027): no server actions, no
 * database, no operator, and it never sees a key — callers pass a funding input plus an @bsv/sdk
 * unlocking template, and sells take a `Holder` that signs one digest. What changes is underneath:
 * state comes from `resolveMerkleLedgerPool`, and a spend carries a fixed-size Merkle proof rather
 * than an embedded holder map, so transactions no longer grow with the holder count.
 *
 *   const pool = new MerkleLedgerPoolClient(genesisTxid, { k, supply, payoutPkh });
 *   const state = await pool.state();
 *   const { rawTx } = await pool.buildBuy({ delta: 5n, ownerPkh, funding });
 *   await pool.broadcast(rawTx);
 *
 * Every build re-resolves from chain and runs the assembled bytes through the interpreter, so a
 * client cannot broadcast a spend the covenant would reject, nor build against a stale tip.
 */
import { Transaction, Script, UnlockingScript } from '@bsv/sdk';
import {
  genesisScript, computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate,
  buyCost, sellRefund, PoolTerms, SlotOp,
} from './merkleLedgerState';
import { validateAssembledCovenantInput } from '../src/covenant';
import { resolveMerkleLedgerPool, ResolvedMerklePool } from './resolveMerkleLedgerPool';

export type { PoolTerms, ResolvedMerklePool };

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const DEFAULT_FEE_RATE = 0.15;
const DUST = 546;

export interface UnlockingScriptTemplate {
  sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
  estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
}

export interface FundingInput {
  sourceTransaction: Transaction;
  outputIndex: number;
  satoshis: number;
  unlock: UnlockingScriptTemplate;
}

export interface Holder {
  ownerPkh: string;
  ownerPubHex: string;
  /** sign a 32-byte digest, returning DER hex WITHOUT the sighash byte */
  signDigest(digestHex: string): Promise<string>;
}

export interface BuiltTx { rawTx: string; txid: string; spentPool: { txid: string; vout: number } }
export interface BuiltBuy extends BuiltTx { cost: bigint; newReserve: number }
export interface BuiltSell extends BuiltTx { refund: bigint; reserveAfter: number }

const p2pkh = (pkh: string) => `76a914${pkh.toLowerCase()}88ac`;

/** Retryable only if the pool outpoint moved under us — never for a genuinely invalid spend. */
function isOutpointConflict(msg: string): boolean {
  return /txn-mempool-conflict|missing inputs|txn-already-known|258:|bad-txns-inputs-missingorspent/i.test(msg);
}

export class MerkleLedgerPoolClient {
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

  /** The locking script to deploy to OPEN a pool with these terms. */
  static genesisScript(terms: PoolTerms): string {
    return genesisScript(terms);
  }

  /** Resolve current state from the blockchain. No DB, no operator. */
  async state(): Promise<ResolvedMerklePool> {
    const r = await resolveMerkleLedgerPool(this.genesisTxid, this.terms, { genesisVout: this.genesisVout });
    if ('error' in r) throw new Error(`resolve pool: ${r.error}`);
    return r;
  }

  quoteBuy(state: ResolvedMerklePool, delta: bigint): bigint {
    return buyCost(this.terms.k, state.sold, delta);
  }

  quoteSell(state: ResolvedMerklePool, amount: bigint): bigint {
    return sellRefund(this.terms.k, state.sold, amount);
  }

  balanceOf(state: ResolvedMerklePool, ownerPkh: string): bigint {
    return state.balances[ownerPkh.toLowerCase()] ?? 0n;
  }

  /** The op history in the shape the state service replays (slot-addressed, as parsed from chain). */
  private ops(state: ResolvedMerklePool): SlotOp[] {
    return state.history.map((o) => ({ ownerPkh: o.ownerPkh, slotIndex: o.slotIndex, delta: o.delta, isNew: o.isNew }));
  }

  /**
   * BUY — keyless. The covenant prices the credit off the curve and requires the reserve to grow
   * by at least that much, so there is no authority to compromise. Appends a slot for a new
   * holder (proving the slot at `holderCount` is empty), otherwise updates the existing one.
   */
  async buildBuy(args: {
    delta: bigint; ownerPkh: string; funding: FundingInput;
    changeScriptHex?: string; state?: ResolvedMerklePool;
  }): Promise<BuiltBuy> {
    const ownerPkh = args.ownerPkh.toLowerCase();
    const state = args.state ?? (await this.state());
    if (state.graduated) throw new Error('pool has graduated — buying is closed');
    if (args.delta <= 0n) throw new Error('delta must be positive');
    if (state.sold + args.delta > this.terms.supply) throw new Error(`exceeds supply (${state.sold} + ${args.delta} > ${this.terms.supply})`);

    const cost = this.quoteBuy(state, args.delta);
    const newReserve = state.reserveSats + Number(cost);
    const spend = computeBuySpend({
      terms: this.terms, history: this.ops(state), ownerPkh, delta: args.delta,
      poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats, newReserve,
    });

    const estSize = (spend.unlockingHex.length + spend.nextLockingHex.length) / 2 + 400;
    const fee = Math.ceil(estSize * this.feeRate);
    const change = args.funding.satoshis - Number(cost) - fee;
    if (change < 0) throw new Error(`funding input ${args.funding.satoshis} is short: need ${Number(cost) + fee} (cost ${cost} + fee ${fee})`);

    // ANYONECANPAY|SINGLE pins only output 0, so change at output 1 is fine
    const outputs = [{ scriptHex: spend.nextLockingHex, satoshis: newReserve }];
    if (change >= DUST) outputs.push({ scriptHex: args.changeScriptHex ?? p2pkh(ownerPkh), satoshis: change });

    const built = await this.assemble(state, spend.unlockingHex, args.funding, outputs);
    return { ...built, cost, newReserve };
  }

  /**
   * The EXACT satoshi value a sell's fee input must hold: the sell unlock is ANYONECANPAY|ALL and
   * the covenant pins exactly two outputs, so no change is possible and the whole fee input
   * becomes the miner fee. A seller must pre-size a UTXO to this value.
   */
  async quoteSellFee(args: { amount: bigint; holder: Pick<Holder, 'ownerPkh'>; state?: ResolvedMerklePool }): Promise<number> {
    const state = args.state ?? (await this.state());
    // unlock ≈ the preimage (dominated by the current pool script) + the 512-byte proof + pushes
    const estSize = state.scriptHex.length / 2 + 800 + state.scriptHex.length / 2 + 400;
    return Math.ceil(estSize * this.feeRate);
  }

  /**
   * SELL — the holder signs one digest, and that signature IS their claim to the slot. There is no
   * operator co-signature in this path at all.
   */
  async buildSell(args: {
    amount: bigint; holder: Holder; funding: FundingInput;
    payoutScriptHex?: string; state?: ResolvedMerklePool;
  }): Promise<BuiltSell> {
    const ownerPkh = args.holder.ownerPkh.toLowerCase();
    const state = args.state ?? (await this.state());
    if (state.graduated) throw new Error('pool has graduated — the ledger is final');
    const bal = this.balanceOf(state, ownerPkh);
    if (args.amount <= 0n) throw new Error('amount must be positive');
    if (args.amount > bal) throw new Error(`insufficient balance: ${bal} < ${args.amount}`);
    const refund = this.quoteSell(state, args.amount);
    if (refund < BigInt(DUST)) throw new Error(`refund ${refund} is below the ${DUST}-sat dust floor — sell more tokens at once`);

    const payoutScriptHex = args.payoutScriptHex ?? p2pkh(ownerPkh);
    const sellArgs = {
      terms: this.terms, history: this.ops(state), ownerPkh, amount: args.amount,
      poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats, payoutScriptHex,
    };
    const digest = computeSellDigest(sellArgs);
    const sigDerHex = await args.holder.signDigest(digest.digestHex);
    const spend = computeSellUnlock({ ...sellArgs, ownerPubHex: args.holder.ownerPubHex, sigDerHex });

    const built = await this.assemble(state, spend.unlockingHex, args.funding, [
      { scriptHex: spend.nextLockingHex, satoshis: digest.reserveAfter },
      { scriptHex: payoutScriptHex, satoshis: Number(spend.refund) },
    ]);
    return { ...built, refund: spend.refund, reserveAfter: digest.reserveAfter };
  }

  /**
   * GRADUATE (terminal, permissionless). Once `sold == supply`, anyone may release the whole
   * reserve to the address fixed at deploy — no signature, and nothing to steer. The graduator may
   * take change, so triggering it costs a fee rather than their whole UTXO.
   */
  async buildGraduate(args: { funding: FundingInput; changeScriptHex?: string; state?: ResolvedMerklePool }): Promise<BuiltTx & { released: number; payoutScriptHex: string }> {
    const state = args.state ?? (await this.state());
    if (state.graduated) throw new Error('pool already graduated');
    if (state.sold !== this.terms.supply) throw new Error(`not fully sold (${state.sold}/${this.terms.supply})`);
    const spend = computeGraduate({
      terms: this.terms, history: this.ops(state),
      poolTxid: state.txid, poolVout: state.vout, reserveBefore: state.reserveSats,
    });
    const outputs = [{ scriptHex: spend.payoutScriptHex, satoshis: state.reserveSats }];
    const fee = Math.ceil((state.scriptHex.length / 2 + 500) * this.feeRate);
    const change = args.changeScriptHex ? args.funding.satoshis - fee : 0;
    if (args.changeScriptHex && change < 0) throw new Error(`funding ${args.funding.satoshis} is short of the ${fee}-sat fee`);
    if (change >= DUST) outputs.push({ scriptHex: args.changeScriptHex!, satoshis: change });

    const built = await this.assemble(state, spend.unlockingHex, args.funding, outputs);
    return { ...built, released: state.reserveSats, payoutScriptHex: spend.payoutScriptHex };
  }

  /**
   * PERMISSIONLESS SEQUENCING — "the loser re-signs". Two clients building against the same tip
   * will collide; the loser re-resolves, rebuilds, re-signs and retries. No sequencer is involved.
   * A rebuilt trade is RE-PRICED at the new curve position, so `repriced` is reported back.
   */
  private async submit<T extends BuiltTx>(
    build: (state: ResolvedMerklePool) => Promise<T>,
    opts: { state?: ResolvedMerklePool; maxAttempts?: number } = {},
  ): Promise<T & { txid: string; attempts: number; repriced: boolean }> {
    const maxAttempts = opts.maxAttempts ?? 4;
    let state = opts.state;
    const firstTip = state ? `${state.txid}:${state.vout}` : '';
    let lastErr = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const s = state ?? (await this.state());
      state = undefined; // retries always re-resolve
      const built = await build(s);
      try {
        const txid = await this.broadcast(built.rawTx);
        return { ...built, txid, attempts: attempt, repriced: !!firstTip && `${s.txid}:${s.vout}` !== firstTip };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!isOutpointConflict(lastErr)) throw e;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
    throw new Error(`lost the sequencing race ${maxAttempts}x (last: ${lastErr})`);
  }

  async submitBuy(args: Parameters<MerkleLedgerPoolClient['buildBuy']>[0] & { maxAttempts?: number }) {
    return this.submit((state) => this.buildBuy({ ...args, state }), { state: args.state, maxAttempts: args.maxAttempts });
  }

  async submitSell(args: Parameters<MerkleLedgerPoolClient['buildSell']>[0] & { maxAttempts?: number }) {
    return this.submit((state) => this.buildSell({ ...args, state }), { state: args.state, maxAttempts: args.maxAttempts });
  }

  /** Assemble [pool input, funding input] -> outputs, and refuse to return bytes the covenant rejects. */
  private async assemble(
    state: ResolvedMerklePool, unlockingHex: string, funding: FundingInput,
    outputs: { scriptHex: string; satoshis: number }[],
  ): Promise<BuiltTx> {
    const tx = new Transaction();
    tx.addInput({ sourceTXID: state.txid, sourceOutputIndex: state.vout, unlockingScript: Script.fromHex(unlockingHex), sequence: 0xffffffff });
    tx.addInput({ sourceTransaction: funding.sourceTransaction, sourceOutputIndex: funding.outputIndex, unlockingScriptTemplate: funding.unlock, sequence: 0xffffffff });
    for (const o of outputs) tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.satoshis });
    await tx.sign();
    const rawTx = tx.toHex();
    const v = validateAssembledCovenantInput(rawTx, { scriptHex: state.scriptHex, satoshis: state.reserveSats }, 0);
    if (!v.ok) throw new Error(`covenant input failed the interpreter: ${v.error}`);
    return { rawTx, txid: tx.id('hex') as string, spentPool: { txid: state.txid, vout: state.vout } };
  }

  async broadcast(rawTx: string): Promise<string> {
    let lastErr = '';
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }) });
        const body = (await res.text()).trim();
        if (res.ok) return body.replace(/"/g, '');
        lastErr = body;
        if (res.status !== 429 && !/rate|limit|timeout|50[023]/i.test(body)) break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    throw new Error(`broadcast failed: ${lastErr}`);
  }
}
