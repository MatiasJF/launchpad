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
import type { WalletInterface } from '@bsv/sdk';
import { Transaction } from '@bsv/sdk';
import { signP2pkhInput } from '@launchpad/bsv/settle/p2pkh';
import { createTokenFundingOutput } from '@launchpad/bsv/settle/funding';
import { curveCost, poolScriptForSold, encodeSellUnlockingHex } from './curvePool';
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
  /** Operator toolbox wallet — funds + signs the P2PKH fee input (input 1). */
  feeWallet: WalletInterface;
  chain: 'main' | 'test';
  pool: StasPoolState; // current reserve covenant (the outpoint the refund spends)
  delta: number; // tokens being sold back
  /** Seller's refund P2PKH LOCKING SCRIPT hex — becomes output 1 (@ curve refund). */
  sellerRefundScriptHex: string;
  /** Operator public key hex whose hash160 == the covenant's operatorPkh gate. */
  operatorPubHex: string;
  /** Raw ECDSA co-signer: sha256sha256(preimage) digest hex -> low-S DER sig hex. */
  signCovenant: (digestHex: string) => Promise<string>;
  feeSats?: number; // miner fee (the funding value is consumed whole; default 200)
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
  const { feeWallet, chain, pool, delta, sellerRefundScriptHex, operatorPubHex, signCovenant, feeSats = 200, originator = ORIGINATOR } = args;

  try {
    if (!Number.isInteger(delta) || delta <= 0) return { ok: false, reason: 'delta must be a positive integer' };
    if (delta > pool.sold) return { ok: false, reason: 'sells more than outstanding (sold)' };
    if (!/^[0-9a-fA-F]+$/.test(sellerRefundScriptHex) || sellerRefundScriptHex.length % 2 !== 0) return { ok: false, reason: 'invalid seller refund script hex' };
    if (!/^0[23][0-9a-fA-F]{64}$/.test(operatorPubHex)) return { ok: false, reason: 'operatorPubHex must be a 33-byte compressed pubkey hex' };

    const newSold = pool.sold - delta;
    // Covenant refund == k·delta·(2·newSold + delta + 1)/2 (curveCost at the post-sell sold).
    const refund = Number(curveCost(BigInt(pool.k), BigInt(newSold), BigInt(delta)));
    const reserveAfter = pool.reserveSats - refund;
    if (reserveAfter < 1) return { ok: false, reason: `refund ${refund} would drain reserve ${pool.reserveSats} below 1` };
    const nextScriptHex = poolScriptForSold(pool.scriptHex, BigInt(newSold));

    // TX1 — operator funds the fee input. Its ENTIRE value is the miner fee: TX2
    // pins exactly two outputs, so there is no change output for the fee input.
    const funding = await createTokenFundingOutput({ wallet: feeWallet, chain, satoshis: feeSats, originator, description: 'stas sell refund fee' });

    // TX2 — the reserve refund.
    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    // input 0: pool covenant
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(pool.scriptHex),
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

    // pool input unlock: operator co-signs sha256sha256(preimage), 0xc1. The preimage
    // (ANYONECANPAY|ALL) commits BOTH outputs, so it is independent of the fee input.
    const poolScript = bsv.Script.fromHex(pool.scriptHex);
    const reserveBN = new bsv.crypto.BN(pool.reserveSats);
    const preimageBuf: Buffer = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_SELL, 0, poolScript, reserveBN);
    const digestHex = (bsv.crypto.Hash.sha256sha256(preimageBuf) as Buffer).toString('hex');
    const der = await signCovenant(digestHex);
    if (!/^[0-9a-fA-F]+$/.test(der)) return { ok: false, reason: 'operator co-sign returned non-hex' };
    const operatorSigHex = der + SIGHASH_SELL.toString(16).padStart(2, '0');
    const unlockHex = encodeSellUnlockingHex(BigInt(delta), sellerRefundScriptHex, operatorPubHex, operatorSigHex, Array.from(preimageBuf) as number[]) + SELL_SELECTOR_HEX;
    tx.inputs[0].setScript(bsv.Script.fromHex(unlockHex));

    // fee input: standard BRC-29 P2PKH signature over ALL (commits both outputs).
    const feeUnlock = await signP2pkhInput({
      wallet: feeWallet, bsv, tx, inputIndex: 1,
      derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_FEE, originator,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(feeUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');

    // Pre-broadcast guard: the covenant sell input of the REAL assembled tx must
    // validate in @bsv/sdk's interpreter (operator sig + '51' selector run here).
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: pool.scriptHex, satoshis: pool.reserveSats }, 0);
    if (!check.ok) return { ok: false, reason: `pool input failed interpreter check: ${check.error}` };

    // TX1's raw hex (from its BEEF) so the caller can push it to the SAME node it
    // broadcasts TX2 to (TX2 references TX1's output).
    let fundingRawTx = '';
    try {
      if (funding.beef && funding.beef.length) fundingRawTx = Transaction.fromAtomicBEEF(funding.beef).toHex();
    } catch {
      fundingRawTx = '';
    }

    return {
      ok: true,
      rawTx,
      txid,
      refund,
      reserveAfter,
      fundingTxid: funding.txid,
      fundingRawTx,
      newPool: { txid, vout: 0, scriptHex: nextScriptHex, reserveSats: reserveAfter, sold: newSold },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
