/// <reference path="./vendor.d.ts" />
/**
 * buyAssembly.ts — assemble a broadcastable BUY against a LinearCurvePool (Phase 1,
 * ADR-026). Mirrors the two-tx settlement pattern (packages/bsv/src/settle/batch.ts):
 *
 *   TX1  buyer wallet createAction funds an exact BRC-29 payment UTXO (cost + dust + fee)
 *   TX2  the buy: [pool covenant input, buyer payment input] -> [successor pool, receipt]
 *
 * Non-custodial enforcement split:
 *   • pool input  (0)  ANYONECANPAY|SINGLE|FORKID (0xc3): the covenant pins output 0
 *                      = successor pool at newReserve >= reserveBefore + curveCost.
 *   • buyer input (1)  ALL|FORKID (0x41): the buyer's own signature commits BOTH
 *                      outputs, so the operator cannot mis-price (covenant stops that)
 *                      nor omit the buyer's token receipt (this signature stops that).
 *
 * The operator only assembles + relays. It never signs the pool input (satisfied by
 * the pushed preimage) and never holds the buyer's key. Nothing is broadcast here.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Transaction, PublicKey, P2PKH } from '@bsv/sdk';
import { signP2pkhInput } from '@launchpad/bsv/settle/p2pkh';
import { createTokenFundingOutput } from '@launchpad/bsv/settle/funding';
import { curveCost, poolScriptForSold, encodeBuyUnlockingHex } from './curvePool';
import { validateAssembledCovenantInput } from './covenant';

const SIGHASH_POOL = 0xc3; // ANYONECANPAY | SINGLE | FORKID
const SIGHASH_BUYER = 0x41; // ALL | FORKID
const ORIGINATOR = 'launchpad.curve.buy';

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

export interface CurvePoolState {
  txid: string;
  vout: number;
  scriptHex: string; // current pool locking script
  reserveSats: number; // pool UTXO satoshi value
  sold: number; // tokens sold so far
  k: number;
  supply: number;
}

export interface CurveBuyArgs {
  wallet: WalletInterface;
  chain: 'main' | 'test';
  pool: CurvePoolState;
  delta: number; // tokens to buy
  buyerReceiveAddress: string; // P2PKH address the token receipt is locked to
  receiptDustSats?: number; // receipt output value (default 546)
  feeSats?: number; // miner fee to size the payment input for (default 200)
  originator?: string;
}

export type CurveBuyResult =
  | {
      ok: true;
      rawTx: string;
      txid: string;
      cost: number;
      paymentTxid: string; // TX1 (funds the payment input) — broadcast this first
      paymentRawTx: string;
      newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number };
      receipt: { vout: number; tokens: number; satoshis: number };
    }
  | { ok: false; reason: string };

export async function buildCurveBuyTx(args: CurveBuyArgs): Promise<CurveBuyResult> {
  const {
    wallet, chain, pool, delta,
    buyerReceiveAddress,
    receiptDustSats = 546,
    feeSats = 200,
    originator = ORIGINATOR,
  } = args;

  try {
    if (!Number.isInteger(delta) || delta <= 0) return { ok: false, reason: 'delta must be a positive integer' };
    if (pool.sold + delta > pool.supply) return { ok: false, reason: 'exceeds curve supply' };

    const cost = Number(curveCost(BigInt(pool.k), BigInt(pool.sold), BigInt(delta)));
    const newReserve = pool.reserveSats + cost;
    const nextSold = pool.sold + delta;
    const nextScriptHex = poolScriptForSold(pool.scriptHex, BigInt(nextSold));

    // TX1 — buyer funds an exact payment input: cost goes into the pool, plus the
    // receipt dust and the miner fee. Non-custodial (buyer's own wallet).
    const payNeeded = cost + receiptDustSats + feeSats;
    const funding = await createTokenFundingOutput({ wallet, chain, satoshis: payNeeded, originator, description: 'curve buy payment' });

    // TX2 — the buy.
    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    // input 0: pool covenant
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(pool.scriptHex),
      pool.reserveSats,
    );
    // input 1: buyer payment
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: funding.txid, outputIndex: funding.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(funding.scriptHex),
      funding.satoshis,
    );
    // output 0: successor pool at newReserve (covenant pins this)
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextScriptHex), satoshis: newReserve }));
    // output 1: buyer token receipt (P2PKH). delta tokens; value is dust.
    const receiptScriptHex = new P2PKH().lock(buyerReceiveAddress).toHex();
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(receiptScriptHex), satoshis: receiptDustSats }));

    // pool input unlock: push (delta, newReserve, preimage). Preimage is 0xc3 over
    // this tx — under ANYONECANPAY|SINGLE it depends only on output 0, so it is
    // independent of the buyer input/receipt we just added.
    const poolScript = bsv.Script.fromHex(pool.scriptHex);
    const reserveBN = new bsv.crypto.BN(pool.reserveSats);
    const preimageBuf: Buffer = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_POOL, 0, poolScript, reserveBN);
    const unlockHex = encodeBuyUnlockingHex(BigInt(delta), newReserve, Array.from(preimageBuf) as number[]);
    tx.inputs[0].setScript(bsv.Script.fromHex(unlockHex));

    // buyer input: standard BRC-29 P2PKH signature over ALL (commits both outputs).
    const buyerUnlock = await signP2pkhInput({
      wallet, bsv, tx, inputIndex: 1,
      derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_BUYER, originator,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(buyerUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');

    // Pre-broadcast guard: the pool input of the REAL assembled tx must validate.
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: pool.scriptHex, satoshis: pool.reserveSats }, 0);
    if (!check.ok) return { ok: false, reason: `pool input failed interpreter check: ${check.error}` };

    return {
      ok: true,
      rawTx,
      txid,
      cost,
      paymentTxid: funding.txid,
      paymentRawTx: '', // TX1 already broadcast by createAction; kept for symmetry
      newPool: { txid, vout: 0, scriptHex: nextScriptHex, reserveSats: newReserve, sold: nextSold },
      receipt: { vout: 1, tokens: delta, satoshis: receiptDustSats },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
