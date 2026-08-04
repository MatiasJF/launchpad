/// <reference path="./vendor.d.ts" />
/**
 * stasBuyAssembly.ts — assemble the broadcastable RESERVE BUY (TX-A) against a
 * StasCurvePool reserve covenant (ADR-028, Option B "stas" variant, step 2).
 *
 * The stas buy is TWO sequenced txs (operator-settled):
 *   TX-A  "reserve buy"  (buyer-signed, THIS file): the buyer pays `cost` sats into
 *         the pool reserve; sold += delta. NO token receipt rides here — STAS is
 *         delivered separately by the operator in TX-B.
 *   TX-B  "STAS delivery" (operator-signed, backend): the operator transfers `delta`
 *         STAS from the vault to the buyer. Sequenced AFTER the buy is recorded.
 *
 * TX-A is the proven LINEAR buy assembly (buyAssembly.ts) minus the receipt output,
 * plus a 1-byte method SELECTOR ('00' = the covenant's first public method, `buy`)
 * appended to the pool unlock — StasCurvePool is a 2-method contract (buy/sell), so
 * the interpreter needs the selector to dispatch. Successor derivation is the same
 * param-agnostic byte-patch (`poolScriptForSold`) — the reserve covenant's only
 * mutable field is `sold`, exactly like the linear pool.
 *
 *   input 0  pool covenant   ANYONECANPAY|SINGLE|FORKID (0xc3): the covenant pins
 *            output 0 = successor pool at newReserve >= reserveBefore + curveCost.
 *   input 1  buyer payment    ALL|FORKID (0x41): the buyer's own signature commits
 *            the WHOLE tx (its single output), so the operator can neither mis-price
 *            (covenant stops that) nor add/alter outputs to divert the buyer's sats
 *            (this SIGHASH_ALL signature stops that) — the anti-shortchange gate.
 *   output 0 successor pool at newReserve (= reserveBefore + cost).
 *
 * The operator only assembles + relays. It never signs the pool input (satisfied by
 * the pushed preimage) and never holds the buyer's key. Nothing is broadcast here.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Transaction } from '@bsv/sdk';
import { signP2pkhInput } from '@launchpad/bsv/settle/p2pkh';
import { createTokenFundingOutput } from '@launchpad/bsv/settle/funding';
import { curveCost, poolScriptForSold, encodeBuyUnlockingHex, sizeCovenantTx, covenantFeeSats } from './curvePool';
import { validateAssembledCovenantInput } from './covenant';

const SIGHASH_POOL = 0xc3; // ANYONECANPAY | SINGLE | FORKID
const SIGHASH_BUYER = 0x41; // ALL | FORKID
/** StasCurvePool method selector for `buy` (first of two public methods). */
const BUY_SELECTOR_HEX = '00';
const ORIGINATOR = 'launchpad.stas.buy';

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

export interface StasPoolState {
  txid: string;
  vout: number;
  scriptHex: string; // current reserve-covenant locking script
  reserveSats: number; // pool UTXO satoshi value (== reserve)
  sold: number; // tokens sold so far (== covenant state)
  k: number;
  supply: number;
}

export interface StasBuyArgs {
  wallet: WalletInterface; // the BUYER's wallet (funds + signs the payment input)
  chain: 'main' | 'test';
  pool: StasPoolState;
  delta: number; // tokens to buy
  /**
   * Optional miner-fee FLOOR (sats). The buyer's payment is sized to `cost + fee`,
   * where `fee` is computed from the ACTUAL TX-A byte size (covenant input preimage
   * + ~3.5 KB covenant output). If this is passed, it acts only as a lower bound —
   * TX-A is NEVER funded below the real size-based fee (else it underpays + evicts).
   */
  feeSats?: number;
  originator?: string;
}

export type StasBuyResult =
  | {
      ok: true;
      rawTx: string;
      txid: string;
      cost: number;
      paymentTxid: string; // TX1 (funds the payment input) — broadcast this first
      paymentRawTx: string;
      newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number };
    }
  | { ok: false; reason: string };

/**
 * Build TX-A (the reserve buy). Mirrors buildCurveBuyTx (the proven linear path)
 * with two changes for the stas variant: (1) no token-receipt output — delivery is
 * TX-B; (2) the pool unlock carries the '00' method selector for the 2-method
 * StasCurvePool. Validates the assembled covenant input via @bsv/sdk BEFORE
 * returning; nothing is broadcast.
 */
export async function buildStasBuyTx(args: StasBuyArgs): Promise<StasBuyResult> {
  const { wallet, chain, pool, delta, feeSats, originator = ORIGINATOR } = args;

  try {
    if (!Number.isInteger(delta) || delta <= 0) return { ok: false, reason: 'delta must be a positive integer' };
    if (pool.sold + delta > pool.supply) return { ok: false, reason: 'exceeds curve supply' };

    const cost = Number(curveCost(BigInt(pool.k), BigInt(pool.sold), BigInt(delta)));
    const newReserve = pool.reserveSats + cost;
    const nextSold = pool.sold + delta;
    const nextScriptHex = poolScriptForSold(pool.scriptHex, BigInt(nextSold));

    const bsv = await loadBsv();
    const poolScript = bsv.Script.fromHex(pool.scriptHex);
    const reserveBN = new bsv.crypto.BN(pool.reserveSats);

    // ── FEE SIZING (money-critical) ──────────────────────────────────────────────
    // The pool unlock is 0xc3 (ANYONECANPAY|SINGLE): the preimage depends ONLY on
    // this input's outpoint + output 0, so it is IDENTICAL whether or not the buyer
    // input is present. We can therefore build the real pool unlock on a sizing tx
    // (pool input + output 0 only) and size TX-A's fee from the ACTUAL bytes — the
    // covenant input's preimage (~3.5 KB scriptCode) + the ~3.5 KB covenant output —
    // BEFORE funding the buyer payment. Sizing at a flat 34 B/output underpaid this
    // ~7 KB tx to ~40 sats → evicted. TX-A has NO change output, so the fee equals
    // exactly (funding − cost); we must fund `cost + fee` where fee ≥ real size.
    const sizingTx = new bsv.Transaction();
    sizingTx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      poolScript,
      pool.reserveSats,
    );
    sizingTx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextScriptHex), satoshis: newReserve }));
    const sizingPreimage: Buffer = bsv.Transaction.sighash.sighashPreimage(sizingTx, SIGHASH_POOL, 0, poolScript, reserveBN);
    const unlockHex = encodeBuyUnlockingHex(BigInt(delta), newReserve, Array.from(sizingPreimage) as number[]) + BUY_SELECTOR_HEX;
    const estSize = sizeCovenantTx(unlockHex.length / 2, [nextScriptHex.length / 2], 1 /* buyer P2PKH input */);
    const sizedFee = covenantFeeSats(estSize); // 0.1 sat/byte, floored
    const fee = Math.max(sizedFee, feeSats ?? 0); // caller `feeSats` is a floor only

    // TX1 — buyer funds an exact payment input: cost goes into the pool reserve,
    // plus the size-based miner fee. No receipt dust (STAS delivery is TX-B). Non-custodial.
    const payNeeded = cost + fee;
    const funding = await createTokenFundingOutput({ wallet, chain, satoshis: payNeeded, originator, description: 'stas reserve buy payment' });

    // TX2 — the reserve buy.
    const tx = new bsv.Transaction();
    // input 0: pool covenant
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      poolScript,
      pool.reserveSats,
    );
    // input 1: buyer payment
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: funding.txid, outputIndex: funding.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(funding.scriptHex),
      funding.satoshis,
    );
    // output 0: successor reserve covenant at newReserve (the covenant pins this).
    // This is the ONLY output — the buyer's SIGHASH_ALL commits it wholesale.
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextScriptHex), satoshis: newReserve }));

    // pool input unlock: push (delta, newReserve, preimage) then the buy selector.
    // Recompute the preimage over the REAL tx (identical bytes — 0xc3 is independent
    // of the buyer input) and assert it matches the sized unlock, so the fee we
    // funded provably covers the exact tx we broadcast.
    const preimageBuf: Buffer = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_POOL, 0, poolScript, reserveBN);
    const realUnlockHex = encodeBuyUnlockingHex(BigInt(delta), newReserve, Array.from(preimageBuf) as number[]) + BUY_SELECTOR_HEX;
    if (realUnlockHex !== unlockHex) return { ok: false, reason: 'pool preimage drifted between sizing and assembly' };
    tx.inputs[0].setScript(bsv.Script.fromHex(realUnlockHex));

    // buyer input: standard BRC-29 P2PKH signature over ALL (commits the tx).
    const buyerUnlock = await signP2pkhInput({
      wallet, bsv, tx, inputIndex: 1,
      derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_BUYER, originator,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(buyerUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');

    // Pre-broadcast guard: the pool input of the REAL assembled tx must validate
    // in @bsv/sdk's Script interpreter (the covenant + '00' selector run here).
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: pool.scriptHex, satoshis: pool.reserveSats }, 0);
    if (!check.ok) return { ok: false, reason: `pool input failed interpreter check: ${check.error}` };

    // TX1's raw hex (from its BEEF) so the caller can push it to the SAME node it
    // broadcasts the buy to (the buy references TX1's output).
    let paymentRawTx = '';
    try {
      if (funding.beef && funding.beef.length) paymentRawTx = Transaction.fromAtomicBEEF(funding.beef).toHex();
    } catch {
      paymentRawTx = '';
    }

    return {
      ok: true,
      rawTx,
      txid,
      cost,
      paymentTxid: funding.txid,
      paymentRawTx,
      newPool: { txid, vout: 0, scriptHex: nextScriptHex, reserveSats: newReserve, sold: nextSold },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
