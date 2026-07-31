/// <reference path="./vendor.d.ts" />
/**
 * stasSellAssembly.ts — assemble the RESERVE-REFUND tx (the covenant SELL) against a
 * StasCurvePool reserve covenant (ADR-028, Option B "stas" variant, step 3, hardened).
 *
 * WHY TWO TXS (not the atomic single tx the ADR sketch imagined): the deployed
 * StasCurvePool.sell() is `@method(SigHash.ANYONECANPAY_ALL)` and asserts
 *   ctx.hashOutputs === hash256(poolOut ++ payoutOut)
 * i.e. the tx must have EXACTLY two outputs — [0] the reserve successor, [1] the seller
 * refund. There is no room for a "STAS returned to the vault" output in the SAME tx, so
 * a stas sell is two sequenced txs: TX1 "STAS return" (holder-signed wallet STAS transfer
 * of `delta` to the operator vault pkh) then TX2 "reserve refund" (this file).
 *
 * PAYEE BINDING (FIX 3): the covenant sell method takes `payoutScript` as an OPERATOR
 * argument and only checks `payoutOut = buildOutput(payoutScript, refund)` — it caps the
 * AMOUNT but does NOT bind the payee, so a compromised operator could redirect output 1
 * to itself. We close that WITHOUT a covenant recompile: the SELLER contributes a
 * SIGHASH_ALL (0x41) fee input to TX2. The covenant input is ANYONECANPAY_ALL (0xc1) so
 * extra inputs are allowed; the seller's 0x41 signature commits ALL outputs, locking
 * output 1 (their refund) — the operator can no longer alter or redirect the payee.
 *
 *   input 0  pool covenant   0xc1 (ANYONECANPAY|ALL): operator co-signs ONLY this input.
 *            Unlock pushes delta, payoutScript, operatorPub, operatorSig, preimage + the
 *            1-byte '51' SELL selector (StasCurvePool is a 2-method contract).
 *   input 1  seller fee       0x41 (ALL): the SELLER funds + signs it — consumed WHOLE as
 *            the miner fee (no change output is possible; the covenant pins two outputs).
 *            The seller's 0x41 sig commits both outputs = the payee lock.
 *   output 0 successor pool @ reserveAfter (= reserveBefore − refund), sold−delta.
 *   output 1 seller refund P2PKH @ the curve refund.
 *
 * Handshake (mirrors the buy's loser-re-signs model): the SELLER builds + signs TX2
 * (`buildStasSellTx`, client) against a specific pool outpoint, leaving the covenant input
 * empty; the OPERATOR co-signs the covenant input (`cosignStasSellTx`, backend) AFTER its
 * back-to-genesis + dedup checks and broadcasts. If the pool moves before finalize, the
 * optimistic outpoint guard rejects and the seller re-signs against the new outpoint.
 * Residual: liveness still rests on the operator broadcasting (acknowledged ADR-028
 * trust) — but redirect of the refund is now cryptographically closed. Broadcasts nothing.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Transaction } from '@bsv/sdk';
import { signP2pkhInput } from '@launchpad/bsv/settle/p2pkh';
import { createTokenFundingOutput } from '@launchpad/bsv/settle/funding';
import { curveCost, poolScriptForSold, encodeSellUnlockingHex } from './curvePool';
import { validateAssembledCovenantInput } from './covenant';
import type { StasPoolState } from './stasBuyAssembly';

const SIGHASH_SELL = 0xc1; // ANYONECANPAY | ALL | FORKID — the covenant sell sighash
const SIGHASH_FEE = 0x41; // ALL | FORKID — the SELLER fee input (commits both outputs)
/** StasCurvePool method selector for `sell` (second of two public methods). */
const SELL_SELECTOR_HEX = '51';
const ORIGINATOR = 'launchpad.stas.sell';

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

/** Curve refund + successor for selling `delta` back from a pool at `sold`/`reserve`. */
export function sellRefundMath(k: number, sold: number, reserveSats: number, delta: number): { newSold: number; refund: number; reserveAfter: number } {
  const newSold = sold - delta;
  const refund = Number(curveCost(BigInt(k), BigInt(newSold), BigInt(delta)));
  return { newSold, refund, reserveAfter: reserveSats - refund };
}

export interface StasSellArgs {
  /** The SELLER's wallet — funds + signs the 0x41 fee input (the payee lock). */
  wallet: WalletInterface;
  chain: 'main' | 'test';
  pool: StasPoolState; // current reserve covenant (the outpoint the refund spends)
  delta: number; // tokens being sold back
  /** Seller's refund P2PKH LOCKING SCRIPT hex — becomes output 1 (@ curve refund). */
  sellerRefundScriptHex: string;
  feeSats?: number; // miner fee (the seller-funded value is consumed whole; default 200)
  originator?: string;
}

export type StasSellResult =
  | {
      ok: true;
      rawTx: string; // TX2 with the SELLER fee input signed (0x41), covenant input EMPTY
      refund: number;
      reserveAfter: number;
      fundingTxid: string; // TX0 (funds the fee input) — broadcast this first
      fundingRawTx: string;
      newPool: { vout: number; scriptHex: string; reserveSats: number; sold: number };
    }
  | { ok: false; reason: string };

/**
 * SELLER side: build TX2 and sign the fee input with SIGHASH_ALL (binding the payee),
 * leaving the covenant input for the operator. Computes the curve refund + successor.
 * Broadcasts nothing. The final txid is not known until the operator adds the covenant
 * unlock (BSV txids cover unlocking scripts), so it is not returned here.
 */
export async function buildStasSellTx(args: StasSellArgs): Promise<StasSellResult> {
  const { wallet, chain, pool, delta, sellerRefundScriptHex, feeSats = 200, originator = ORIGINATOR } = args;

  try {
    if (!Number.isInteger(delta) || delta <= 0) return { ok: false, reason: 'delta must be a positive integer' };
    if (delta > pool.sold) return { ok: false, reason: 'sells more than outstanding (sold)' };
    if (!/^[0-9a-fA-F]+$/.test(sellerRefundScriptHex) || sellerRefundScriptHex.length % 2 !== 0) return { ok: false, reason: 'invalid seller refund script hex' };

    const { newSold, refund, reserveAfter } = sellRefundMath(pool.k, pool.sold, pool.reserveSats, delta);
    if (reserveAfter < 1) return { ok: false, reason: `refund ${refund} would drain reserve ${pool.reserveSats} below 1` };
    const nextScriptHex = poolScriptForSold(pool.scriptHex, BigInt(newSold));

    // TX0 — the seller funds the fee input (consumed WHOLE as the miner fee: TX2 pins two
    // outputs, so there is no change output for it).
    const funding = await createTokenFundingOutput({ wallet, chain, satoshis: feeSats, originator, description: 'stas sell refund fee (seller)' });

    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    // input 0: pool covenant (unlock left EMPTY — operator co-signs)
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(pool.scriptHex),
      pool.reserveSats,
    );
    // input 1: seller fee input
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: funding.txid, outputIndex: funding.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(funding.scriptHex),
      funding.satoshis,
    );
    // output 0: successor reserve covenant @ reserveAfter (covenant-pinned).
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextScriptHex), satoshis: reserveAfter }));
    // output 1: seller refund @ the curve refund (seller SIGHASH_ALL binds this).
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(sellerRefundScriptHex), satoshis: refund }));

    // Seller signs the fee input over ALL — commits BOTH outputs (the payee lock).
    const feeUnlock = await signP2pkhInput({
      wallet, bsv, tx, inputIndex: 1,
      derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_FEE, originator,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(feeUnlock));

    const rawTx: string = tx.toString();

    let fundingRawTx = '';
    try {
      if (funding.beef && funding.beef.length) fundingRawTx = Transaction.fromAtomicBEEF(funding.beef).toHex();
    } catch {
      fundingRawTx = '';
    }

    return {
      ok: true,
      rawTx,
      refund,
      reserveAfter,
      fundingTxid: funding.txid,
      fundingRawTx,
      newPool: { vout: 0, scriptHex: nextScriptHex, reserveSats: reserveAfter, sold: newSold },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface CosignStasSellArgs {
  /** TX2 from `buildStasSellTx`: fee input signed (0x41), covenant input EMPTY. */
  sellerSignedRawTx: string;
  poolScriptHex: string; // the covenant prevout locking script (input 0)
  reserveBefore: number; // the covenant prevout value
  delta: number; // sell size — must match the outputs the seller committed
  sellerRefundScriptHex: string; // output-1 payout script (must match the seller's tx)
  operatorPubHex: string; // operator pubkey whose hash160 == the covenant operatorPkh
  /** Raw ECDSA co-signer: sha256sha256(preimage) digest hex -> low-S DER sig hex. */
  signCovenant: (digestHex: string) => Promise<string>;
}

export type CosignStasSellResult = { ok: true; rawTx: string; txid: string } | { ok: false; reason: string };

/**
 * OPERATOR side: co-sign ONLY the covenant input (0xc1) of the seller-signed TX2 and
 * finalise it. The covenant preimage (ANYONECANPAY|ALL) is recomputed from the tx (its
 * outputs + input-0 outpoint), independent of the seller fee input's unlock — so filling
 * the covenant unlock does not invalidate the seller's 0x41 signature, and the seller's
 * signature has already locked output 1 (the operator cannot redirect the refund). The
 * assembled covenant input is re-validated in @bsv/sdk before returning. Broadcasts
 * nothing. The caller (finalizeStasSell) MUST separately verify the outputs/outpoint and
 * run back-to-genesis + dedup BEFORE calling this.
 */
export async function cosignStasSellTx(args: CosignStasSellArgs): Promise<CosignStasSellResult> {
  const { sellerSignedRawTx, poolScriptHex, reserveBefore, delta, sellerRefundScriptHex, operatorPubHex, signCovenant } = args;
  try {
    if (!/^[0-9a-fA-F]+$/.test(sellerSignedRawTx) || sellerSignedRawTx.length % 2 !== 0) return { ok: false, reason: 'invalid seller-signed raw tx' };
    if (!/^0[23][0-9a-fA-F]{64}$/.test(operatorPubHex)) return { ok: false, reason: 'operatorPubHex must be a 33-byte compressed pubkey hex' };

    const bsv = await loadBsv();
    const tx = new bsv.Transaction(sellerSignedRawTx);
    if (!tx.inputs || tx.inputs.length !== 2) return { ok: false, reason: 'TX2 must have exactly 2 inputs (covenant, seller fee)' };
    if (!tx.outputs || tx.outputs.length !== 2) return { ok: false, reason: 'TX2 must have exactly 2 outputs (successor, refund)' };

    const poolScript = bsv.Script.fromHex(poolScriptHex);
    const reserveBN = new bsv.crypto.BN(reserveBefore);
    const preimageBuf: Buffer = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_SELL, 0, poolScript, reserveBN);
    const digestHex = (bsv.crypto.Hash.sha256sha256(preimageBuf) as Buffer).toString('hex');
    const der = await signCovenant(digestHex);
    if (!/^[0-9a-fA-F]+$/.test(der)) return { ok: false, reason: 'operator co-sign returned non-hex' };
    const operatorSigHex = der + SIGHASH_SELL.toString(16).padStart(2, '0');
    const unlockHex = encodeSellUnlockingHex(BigInt(delta), sellerRefundScriptHex, operatorPubHex, operatorSigHex, Array.from(preimageBuf) as number[]) + SELL_SELECTOR_HEX;
    tx.inputs[0].setScript(bsv.Script.fromHex(unlockHex));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');

    const check = validateAssembledCovenantInput(rawTx, { scriptHex: poolScriptHex, satoshis: reserveBefore }, 0);
    if (!check.ok) return { ok: false, reason: `covenant input failed interpreter check: ${check.error}` };

    return { ok: true, rawTx, txid };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
