/// <reference path="./vendor.d.ts" />
/**
 * stasSellAssembly.ts — assemble the broadcastable RESERVE-REFUND tx (the covenant
 * SELL) against a StasCurvePool reserve covenant (ADR-028, Option B "stas" variant,
 * step 3). The operator co-signs this tx to refund a seller the curve price.
 *
 * WHY TWO TXS (not the atomic single tx the ADR sketch imagined): the deployed
 * StasCurvePool.sell() is `@method(SigHash.ANYONECANPAY_ALL)` and asserts
 *   ctx.hashOutputs === hash256(poolOut ++ payoutOut)
 * i.e. the tx must have EXACTLY two outputs — [0] the reserve successor, [1] the
 * seller's sats refund. There is no room for a third "STAS returned to the vault"
 * output in the SAME tx, so the holder's STAS return cannot ride here (its own STAS
 * covenant would also demand a STAS continuation output, which this covenant forbids).
 * A 3-output atomic sell would fail the covenant's hashOutputs check in @bsv/sdk. So
 * a stas sell is two sequenced txs (mirrors verify-stas.ts's canonical `buildSell`):
 *   TX1 "STAS return"  (holder-signed, client/wallet): the holder transfers `delta`
 *        STAS to the operator vault pkh. Standard wallet STAS transfer (deferred UI).
 *   TX2 "reserve refund" (operator-cosigned, THIS file): pays the curve refund to the
 *        seller from the reserve; sold -= delta. Built + broadcast by the operator
 *        only AFTER it verifies TX1's returned STAS is genuine (back-to-genesis).
 *
 *   input 0  pool covenant   ANYONECANPAY|ALL|FORKID (0xc1): the covenant pins BOTH
 *            outputs (successor pool @ reserveAfter, seller refund @ curve refund) and
 *            requires the operator's checkSig — the anti-forgery gate. Its unlock
 *            pushes (delta, payoutScript, operatorPub, operatorSig, preimage) then the
 *            1-byte '51' SELL selector (StasCurvePool is a 2-method contract).
 *   input 1  fee input       ALL|FORKID (0x41): an operator-funded P2PKH consumed
 *            ENTIRELY as the miner fee — no change output is possible (the covenant
 *            pins exactly two outputs), so the funding value == the fee.
 *   output 0 successor pool @ reserveAfter (= reserveBefore − refund), sold−delta.
 *   output 1 seller refund P2PKH @ refund (= curve refund at the post-sell `sold`).
 *
 * The covenant CAPS the payout at the curve refund and pins the successor, so the
 * operator can authorise or refuse a sell but can NEVER overpay or drain the reserve.
 * (Payee-binding note: the covenant does not bind output 1 to the *seller* — that is
 * the operator's responsibility in the two-tx form; see ADR-028 step-3.) Nothing is
 * broadcast here — the caller broadcasts the funding tx then this tx explicitly.
 */
import { Transaction } from '@bsv/sdk';
import { buildOperatorFundingTx, signOperatorP2pkhInput, type OperatorBaseUtxo } from '@launchpad/bsv/settle/base-funding';
import { curveCost, poolScriptForSold, encodeSellUnlockingHex, sizeCovenantTx, covenantFeeSats } from './curvePool';
import { validateAssembledCovenantInput } from './covenant';
import type { StasPoolState } from './stasBuyAssembly';

const SIGHASH_SELL = 0xc1; // ANYONECANPAY | ALL | FORKID — the covenant sell sighash
const SIGHASH_FEE = 0x41; // ALL | FORKID — the operator fee input
/** StasCurvePool method selector for `sell` (second of two public methods). */
const SELL_SELECTOR_HEX = '51';
const ORIGINATOR = 'launchpad.stas.sell';

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

export interface StasSellArgs {
  chain: 'main' | 'test';
  pool: StasPoolState; // current reserve covenant (the outpoint the refund spends)
  delta: number; // tokens being sold back
  /** Seller's refund P2PKH LOCKING SCRIPT hex — becomes output 1 (@ curve refund). */
  sellerRefundScriptHex: string;
  /** Operator public key hex whose hash160 == the covenant's operatorPkh gate. */
  operatorPubHex: string;
  /** hash160 (hex) of the operator base address — owns the flat-key fee-funding UTXOs. */
  basePkh: string;
  /** Raw ECDSA co-signer for the covenant input: sha256sha256(preimage) digest hex -> low-S DER sig hex. */
  signCovenant: (digestHex: string) => Promise<string>;
  /** Raw ECDSA signer for the fee input(s) (flat-key P2PKH): digest hex -> low-S DER sig hex (operatorSignDigest). */
  signFeeDigest: (digestHex: string) => Promise<string>;
  /** List the operator base-address spendable UTXOs (WoC address lookup, app-injected). */
  fetchUtxos: () => Promise<OperatorBaseUtxo[]>;
  /** Fetch a tx's unconfirmed-safe ancestry BEEF (getSourceBeefDeep, app-injected). */
  fetchBeef: (txid: string) => Promise<number[] | null>;
  /**
   * Optional miner-fee FLOOR (sats). The TX1 funding output (consumed WHOLE as TX2's
   * fee — the covenant pins exactly two outputs, so TX2 carries no change) is sized to
   * the ACTUAL TX2 byte size (covenant input preimage + ~3.5 KB covenant output + the
   * seller refund output). If passed, this is a lower bound only — TX2 is NEVER funded
   * below the real size-based fee (else it underpays + evicts).
   */
  feeSats?: number;
  originator?: string;
}

export type StasSellResult =
  | {
      ok: true;
      rawTx: string; // TX2 (the reserve refund) — broadcast AFTER fundingRawTx
      txid: string;
      refund: number; // sats refunded to the seller (the curve refund)
      reserveAfter: number; // successor pool value
      fundingTxid: string; // TX1 (funds the fee input) — broadcast this first
      fundingRawTx: string;
      /** TX1's atomic ancestry BEEF (base UTXO ancestry + TX1) — flush this chain first. */
      fundingBeef: number[];
      newPool: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number };
    }
  | { ok: false; reason: string };

/**
 * Build TX2 (the reserve refund / covenant sell). Mirrors verify-stas.ts's canonical
 * `buildSell` (operator pub + sig + '51' selector, 0xc1 sighash, byte-patch successor)
 * on a REAL broadcastable tx with an operator-funded fee input. Computes the curve
 * refund + successor, co-signs the covenant input, and validates the assembled
 * covenant input via @bsv/sdk BEFORE returning. Broadcasts nothing.
 */
export async function buildStasSellRefundTx(args: StasSellArgs): Promise<StasSellResult> {
  const { chain, pool, delta, sellerRefundScriptHex, operatorPubHex, basePkh, signCovenant, signFeeDigest, fetchUtxos, fetchBeef, feeSats, originator = ORIGINATOR } = args;
  void chain;
  void originator;

  try {
    if (!Number.isInteger(delta) || delta <= 0) return { ok: false, reason: 'delta must be a positive integer' };
    if (delta > pool.sold) return { ok: false, reason: 'sells more than outstanding (sold)' };
    if (!/^[0-9a-fA-F]+$/.test(sellerRefundScriptHex) || sellerRefundScriptHex.length % 2 !== 0) return { ok: false, reason: 'invalid seller refund script hex' };
    if (!/^0[23][0-9a-fA-F]{64}$/.test(operatorPubHex)) return { ok: false, reason: 'operatorPubHex must be a 33-byte compressed pubkey hex' };
    if (!/^[0-9a-fA-F]{40}$/.test(basePkh)) return { ok: false, reason: 'basePkh must be a 20-byte pkh hex' };

    const newSold = pool.sold - delta;
    // Covenant refund == k·delta·(2·newSold + delta + 1)/2 (curveCost at the post-sell sold).
    const refund = Number(curveCost(BigInt(pool.k), BigInt(newSold), BigInt(delta)));
    const reserveAfter = pool.reserveSats - refund;
    if (reserveAfter < 1) return { ok: false, reason: `refund ${refund} would drain reserve ${pool.reserveSats} below 1` };
    const nextScriptHex = poolScriptForSold(pool.scriptHex, BigInt(newSold));

    const bsv = await loadBsv();
    const poolScript = bsv.Script.fromHex(pool.scriptHex);
    const reserveBN = new bsv.crypto.BN(pool.reserveSats);

    // ── FEE SIZING (money-critical) ──────────────────────────────────────────────
    // The pool unlock is 0xc1 (ANYONECANPAY|ALL): the preimage commits BOTH outputs
    // but is INDEPENDENT of the fee input, so we co-sign the covenant on a sizing tx
    // (pool input + the two pinned outputs only) and size TX2's fee from the ACTUAL
    // bytes — the covenant input's preimage (~3.5 KB scriptCode) + the ~3.5 KB
    // successor covenant output + the seller refund — BEFORE we fund the fee input.
    // Sizing at a flat 34 B/output underpaid this ~7 KB tx to ~40 sats → evicted.
    // TX2 has NO change (the covenant pins exactly two outputs), so its fee equals the
    // TX1 funding output consumed whole; that output MUST be ≥ the real size-based fee.
    const sizingTx = new bsv.Transaction();
    sizingTx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      poolScript,
      pool.reserveSats,
    );
    sizingTx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextScriptHex), satoshis: reserveAfter }));
    sizingTx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(sellerRefundScriptHex), satoshis: refund }));
    const sizingPreimage: Buffer = bsv.Transaction.sighash.sighashPreimage(sizingTx, SIGHASH_SELL, 0, poolScript, reserveBN);
    const digestHex = (bsv.crypto.Hash.sha256sha256(sizingPreimage) as Buffer).toString('hex');
    const der = await signCovenant(digestHex);
    if (!/^[0-9a-fA-F]+$/.test(der)) return { ok: false, reason: 'operator co-sign returned non-hex' };
    const operatorSigHex = der + SIGHASH_SELL.toString(16).padStart(2, '0');
    const unlockHex = encodeSellUnlockingHex(BigInt(delta), sellerRefundScriptHex, operatorPubHex, operatorSigHex, Array.from(sizingPreimage) as number[]) + SELL_SELECTOR_HEX;
    const estSize = sizeCovenantTx(unlockHex.length / 2, [nextScriptHex.length / 2, sellerRefundScriptHex.length / 2], 1 /* operator fee P2PKH input */);
    const sizedFee = covenantFeeSats(estSize); // 0.1 sat/byte, floored
    const fee = Math.max(sizedFee, feeSats ?? 0); // caller `feeSats` is a floor only

    // TX1 — a flat-key P2PKH split tx funded from the operator BASE address that mints
    // an EXACT-fee output (`fee`) at base + BSV change back to base. TX2 consumes that
    // output WHOLE as its miner fee. (Drops @bsv/wallet-toolbox off the refund path — ADR-028 revised.)
    const fundingRes = await buildOperatorFundingTx({ basePkh, operatorPubHex, outputSats: fee, fetchUtxos, fetchBeef, signFeeDigest });
    if (!fundingRes.ok) return { ok: false, reason: `sell fee funding (TX1): ${fundingRes.reason}` };
    const funding = fundingRes.funding;

    // TX2 — the reserve refund.
    const tx = new bsv.Transaction();
    // input 0: pool covenant
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      poolScript,
      pool.reserveSats,
    );
    // input 1: operator fee input (consumed whole as the miner fee)
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: funding.txid, outputIndex: funding.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(funding.scriptHex),
      funding.satoshis,
    );
    // output 0: successor reserve covenant @ reserveAfter (covenant-pinned).
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextScriptHex), satoshis: reserveAfter }));
    // output 1: seller refund @ the curve refund (covenant-pinned amount + script).
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(sellerRefundScriptHex), satoshis: refund }));

    // pool input unlock: reuse the co-signed unlock from sizing. The 0xc1 preimage is
    // independent of the fee input, so recompute it over the REAL tx and assert byte
    // equality — this proves the funded fee covers exactly the tx we broadcast, while
    // avoiding a second (non-deterministic-length) signature.
    const preimageBuf: Buffer = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_SELL, 0, poolScript, reserveBN);
    if (Buffer.from(preimageBuf).toString('hex') !== Buffer.from(sizingPreimage).toString('hex')) {
      return { ok: false, reason: 'pool preimage drifted between sizing and assembly' };
    }
    tx.inputs[0].setScript(bsv.Script.fromHex(unlockHex));

    // fee input: flat-key P2PKH signature over ALL (commits both outputs). The operator
    // base key signs via the raw-ECDSA callback — no toolbox wallet on the path.
    const feeUnlock = await signOperatorP2pkhInput({
      bsv, tx, inputIndex: 1,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_FEE,
      operatorPubHex, signFeeDigest,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(feeUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');

    // Pre-broadcast guard: the covenant sell input of the REAL assembled tx must
    // validate in @bsv/sdk's interpreter (operator sig + '51' selector run here).
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: pool.scriptHex, satoshis: pool.reserveSats }, 0);
    if (!check.ok) return { ok: false, reason: `pool input failed interpreter check: ${check.error}` };

    return {
      ok: true,
      rawTx,
      txid,
      refund,
      reserveAfter,
      fundingTxid: funding.txid,
      fundingRawTx: fundingRes.fundingRawTx,
      fundingBeef: fundingRes.fundingBeef,
      newPool: { txid, vout: 0, scriptHex: nextScriptHex, reserveSats: reserveAfter, sold: newSold },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
