/// <reference path="../vendor.d.ts" />

/**
 * operatorBaseFunding.ts — flat-key operator fee funding for the STAS trade path
 * (ADR-028, revised). This REPLACES the `@bsv/wallet-toolbox` custody wallet on the
 * hot operator paths (per-buy delivery, per-sell refund).
 *
 * WHY (money-critical): the toolbox custody keeps corrupting under trade load — its
 * remote storage rejects every `createAction` ("merged Beef failed validation") once
 * the operator holds a chain of unconfirmed txs (a delivery per buy, a refund per
 * sell). The flat key + WhatsOnChain path was already proven robust for the STAS
 * token input and for `operator-fund.mjs`'s multi-pass unconfirmed-chain broadcast.
 *
 * So the operator funds its own tx fees from spendable sats sitting at its BASE
 * P2PKH address (owner pkh = hash160(operator pubkey), the same key that co-signs the
 * covenant and owns the STAS vault). This module is PURE — it never touches the
 * private key. Signing is done via a caller-supplied `signFeeDigest` callback (raw
 * low-S ECDSA over a digest, backed by operatorSignDigest in the app), exactly the
 * way `operatorDeliverStas` already takes `signTokenDigest`. WoC I/O (list UTXOs,
 * fetch ancestry BEEF) is also injected as callbacks so the key + network stay in the
 * app layer, never in this package.
 *
 * Two shapes, because the two trade txs pin their outputs differently:
 *   • DELIVERY can carry a BSV-change output (the STAS engine permits extra outputs),
 *     so `selectOperatorFeeInputs` returns the base UTXO(s) as DIRECT fee inputs and
 *     the delivery tx sends change straight back to base — no separate funding tx.
 *   • SELL REFUND's covenant pins EXACTLY two outputs (successor pool + seller refund)
 *     under ANYONECANPAY_ALL, so no change output is allowed in the refund tx and the
 *     fee input must be consumed WHOLE as the miner fee. `buildOperatorFundingTx`
 *     therefore builds a tiny flat-key P2PKH split tx (TX1) that mints an exact-fee
 *     output at base (with BSV change back to base) for the refund to consume whole.
 */
import { Beef, Transaction } from '@bsv/sdk';

/** A spendable base-address UTXO (from a WoC address lookup). */
export interface OperatorBaseUtxo {
  txid: string;
  vout: number;
  satoshis: number;
}

/** A selected, ancestry-anchored operator fee input. */
export interface OperatorFeeInput {
  txid: string;
  vout: number;
  scriptHex: string; // P2PKH: 76a914 <basePkh> 88ac
  satoshis: number;
  beef: number[]; // ancestry BEEF (getSourceBeefDeep) — unconfirmed-safe SPV anchor
}

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

/** Standard P2PKH locking-script hex for a pkh (the operator base address script). */
export function p2pkhScriptHexForPkh(pkh: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(pkh)) throw new Error(`invalid pkh: ${pkh}`);
  return `76a914${pkh.toLowerCase()}88ac`;
}

/**
 * Sign a plain P2PKH input with the operator FLAT key via the `signFeeDigest`
 * callback (raw low-S DER over sha256sha256(preimage)). Mirrors `signP2pkhInput`
 * but with a raw ECDSA callback instead of `wallet.createSignature`, so the operator
 * key never enters this package. Returns the unlocking-script hex (`<sig+sighash> <pub>`).
 */
export async function signOperatorP2pkhInput(args: {
  bsv: any;
  tx: any;
  inputIndex: number;
  sourceScriptHex: string;
  sourceSatoshis: number;
  sighashType: number;
  operatorPubHex: string;
  signFeeDigest: (digestHex: string) => Promise<string>;
}): Promise<string> {
  const { bsv, tx, inputIndex, sourceScriptHex, sourceSatoshis, sighashType, operatorPubHex, signFeeDigest } = args;
  const sourceLocking = bsv.Script.fromHex(sourceScriptHex);
  const satsBN = new bsv.crypto.BN(sourceSatoshis);
  const preimage = bsv.Transaction.sighash.sighashPreimage(tx, sighashType, inputIndex, sourceLocking, satsBN);
  const digestHex = (bsv.crypto.Hash.sha256sha256(preimage) as Buffer).toString('hex');
  const der = await signFeeDigest(digestHex);
  if (!/^[0-9a-fA-F]+$/.test(der)) throw new Error('signFeeDigest returned non-hex');
  const sigHex = der + sighashType.toString(16).padStart(2, '0');
  return bsv.Script.fromASM(`${sigHex} ${operatorPubHex}`).toHex();
}

/**
 * Fee-input sizing. TX1 here is a SMALL flat-key P2PKH split tx (N inputs + 2 P2PKH
 * outputs of 34 B each — genuinely 34 B, unlike the ~3.5 KB covenant outputs the
 * curve txs carry), so the 2×34 output sizing below is correct. The RATE is raised
 * to 0.1 sat/byte. NOTE: this used to say "to match the covenant txs", but the covenant rate is now
 * 0.01 (measured — ADR-031). This is left at 0.1 deliberately: these are small P2PKH funding txs
 * where MIN_FEE=40 dominates anyway, so lowering it would change almost nothing while adding
 * unmeasured risk to the shipped path.
 */
const FEE_RATE = 0.1;
const MIN_FEE = 40;

/**
 * Select operator base UTXO(s) whose total covers `needSats` and return them as
 * ancestry-anchored fee inputs (for DIRECT use as extra inputs in the delivery tx).
 * Largest-first so the fewest inputs cover the need. Each input's ancestry BEEF is
 * fetched via `fetchBeef` (getSourceBeefDeep — unconfirmed-safe: a base UTXO may be
 * operator change from a prior op that hasn't confirmed yet). Fail-closed: any UTXO
 * whose BEEF cannot be built OR that is already spent is skipped; insufficient
 * coverage returns an error.
 *
 * FIX (money-critical): spent-check is now ENFORCED at package boundary via the
 * required `fetchIsUnspent` callback (WoC `/tx/{txid}/{vout}/spent` — see field
 * notes: `/address/{addr}/unspent` returns already-spent outputs). Every candidate
 * is verified unspent BEFORE attempting BEEF fetch, so a fresh process cannot
 * double-spend on first tx.
 */
export async function selectOperatorFeeInputs(args: {
  basePkh: string;
  needSats: number;
  fetchUtxos: () => Promise<OperatorBaseUtxo[]>;
  fetchBeef: (txid: string) => Promise<number[] | null>;
  fetchIsUnspent: (txid: string, vout: number) => Promise<boolean | null>;
  fetchUnconfirmedDepth?: (txid: string) => Promise<number | null>;
  maxInputs?: number;
  maxUnconfirmedDepth?: number;
}): Promise<{ ok: true; feeInputs: OperatorFeeInput[]; totalSats: number } | { ok: false; reason: string }> {
  const { basePkh, needSats, fetchUtxos, fetchBeef, fetchIsUnspent, fetchUnconfirmedDepth, maxInputs = 5, maxUnconfirmedDepth = 10 } = args;
  let scriptHex: string;
  try {
    scriptHex = p2pkhScriptHexForPkh(basePkh);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  let utxos: OperatorBaseUtxo[];
  try {
    utxos = (await fetchUtxos()).filter((u) => u && /^[0-9a-fA-F]{64}$/.test(u.txid) && Number.isInteger(u.vout) && u.vout >= 0 && u.satoshis > 0);
  } catch (e) {
    return { ok: false, reason: `fetch base UTXOs failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (utxos.length === 0) return { ok: false, reason: `operator base address (${basePkh}) has no spendable UTXOs — fund it` };
  utxos.sort((a, b) => b.satoshis - a.satoshis); // largest-first

  const feeInputs: OperatorFeeInput[] = [];
  let total = 0;
  let allTooDeep = true; // track if we found ANY shallow UTXO
  for (const u of utxos) {
    if (total >= needSats) break;
    if (feeInputs.length >= maxInputs) break;
    // SPENT CHECK (money-critical): verify this UTXO is actually unspent before
    // attempting to use it. WoC /address/unspent returns already-spent outputs
    // (field notes: confirmed-but-spent outputs from 50 blocks ago). Check the
    // canonical spent endpoint; skip if spent or unverifiable (fail-closed).
    const unspent = await fetchIsUnspent(u.txid, u.vout);
    if (unspent !== true) continue; // spent (false) or unverifiable (null) — skip
    // MEMPOOL DEPTH CHECK (money-critical): avoid selecting a UTXO whose deep
    // unconfirmed ancestry would blow the node's 25-ancestor mempool limit,
    // causing "too-long-mempool-chain" broadcast rejection. Prefer shallow UTXOs
    // (≤ maxUnconfirmedDepth ancestors). If depth check is provided and this UTXO
    // is too deep, skip it (fail-closed: assume deep if unverifiable).
    if (fetchUnconfirmedDepth) {
      const depth = await fetchUnconfirmedDepth(u.txid);
      if (depth !== null && depth > maxUnconfirmedDepth) continue; // too deep — skip
      if (depth === null) continue; // unverifiable — skip (fail-closed)
      if (depth <= maxUnconfirmedDepth) allTooDeep = false; // found a shallow one
    } else {
      allTooDeep = false; // no depth check = assume OK
    }
    const beef = await fetchBeef(u.txid);
    if (!beef) continue; // can't anchor this UTXO's ancestry — skip (fail-closed)
    feeInputs.push({ txid: u.txid, vout: u.vout, scriptHex, satoshis: u.satoshis, beef });
    total += u.satoshis;
  }
  // FAIL BEFORE BROADCAST (money-critical): if ALL available UTXOs have deep
  // unconfirmed ancestry (> maxUnconfirmedDepth), building will assemble a tx that
  // WILL be rejected at broadcast with "too-long-mempool-chain". Stop here with a
  // clear error instead of silently building a doomed tx.
  if (fetchUnconfirmedDepth && allTooDeep && utxos.length > 0) {
    return { ok: false, reason: `all ${utxos.length} operator base UTXO(s) have deep unconfirmed ancestry (> ${maxUnconfirmedDepth}) — wait for confirmation or fund from fresh confirmed source to avoid too-long-mempool-chain` };
  }
  if (total < needSats) {
    return { ok: false, reason: `operator base has ${total} shallow+anchorable sats across ${feeInputs.length} input(s), need ${needSats}` };
  }
  return { ok: true, feeInputs, totalSats: total };
}

/**
 * Build TX1 for the SELL refund: a flat-key P2PKH split tx that produces an exact
 * `outputSats` funding output at the operator base address (output 0) plus BSV change
 * back to base (output 1). The refund tx (TX2) then consumes output 0 WHOLE as its
 * miner fee — the covenant pins exactly two outputs, so TX2 itself can carry no change.
 *
 * Returns the funding outpoint, TX1's raw hex, and TX1's atomic ancestry BEEF (base
 * UTXO ancestry + TX1) so the caller can flush the whole unconfirmed chain to WoC
 * (parents-first, multi-pass) before broadcasting TX2.
 */
export async function buildOperatorFundingTx(args: {
  basePkh: string;
  operatorPubHex: string;
  outputSats: number;
  fetchUtxos: () => Promise<OperatorBaseUtxo[]>;
  fetchBeef: (txid: string) => Promise<number[] | null>;
  fetchIsUnspent: (txid: string, vout: number) => Promise<boolean | null>;
  fetchUnconfirmedDepth?: (txid: string) => Promise<number | null>;
  signFeeDigest: (digestHex: string) => Promise<string>;
  sighashType?: number;
  maxUnconfirmedDepth?: number;
}): Promise<
  | { ok: true; funding: { txid: string; vout: number; scriptHex: string; satoshis: number }; fundingRawTx: string; fundingBeef: number[]; changeSats: number }
  | { ok: false; reason: string }
> {
  const { basePkh, operatorPubHex, outputSats, fetchUtxos, fetchBeef, fetchIsUnspent, fetchUnconfirmedDepth, signFeeDigest, maxUnconfirmedDepth } = args;
  // SIGHASH_ALL | FORKID (0x41) — a standard P2PKH spend committing all outputs.
  const sighashType = args.sighashType ?? 0x41;
  try {
    const baseScriptHex = p2pkhScriptHexForPkh(basePkh);
    // Size TX1: N inputs + 2 outputs. Select enough to cover output + tx1 fee + dust.
    // Over-estimate inputs at the cap so selection never comes up short.
    const est = (nIn: number) => Math.max(MIN_FEE, Math.ceil((10 + nIn * 148 + 2 * 34) * FEE_RATE));
    const need = outputSats + est(5) + 1;
    const sel = await selectOperatorFeeInputs({ basePkh, needSats: need, fetchUtxos, fetchBeef, fetchIsUnspent, fetchUnconfirmedDepth, maxUnconfirmedDepth });
    if (!sel.ok) return { ok: false, reason: sel.reason };

    const tx1Fee = est(sel.feeInputs.length);
    const changeSats = sel.totalSats - outputSats - tx1Fee;
    if (changeSats < 1) return { ok: false, reason: `selected ${sel.totalSats} sats cannot cover output ${outputSats} + fee ${tx1Fee} + change` };

    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    for (const fi of sel.feeInputs) {
      tx.from({ txId: fi.txid, outputIndex: fi.vout, script: fi.scriptHex, satoshis: fi.satoshis });
    }
    // output 0: the exact-fee funding output (consumed WHOLE by TX2); output 1: change.
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(baseScriptHex), satoshis: outputSats }));
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(baseScriptHex), satoshis: changeSats }));
    for (const [i, fi] of sel.feeInputs.entries()) {
      tx.inputs[i].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(fi.scriptHex), satoshis: fi.satoshis });
    }
    for (const [i, fi] of sel.feeInputs.entries()) {
      const unlock = await signOperatorP2pkhInput({ bsv, tx, inputIndex: i, sourceScriptHex: fi.scriptHex, sourceSatoshis: fi.satoshis, sighashType, operatorPubHex, signFeeDigest });
      tx.inputs[i].setScript(bsv.Script.fromHex(unlock));
    }

    const fundingRawTx: string = tx.toString();
    const sdkTx = Transaction.fromHex(fundingRawTx);
    const txid = sdkTx.id('hex');

    // Atomic ancestry BEEF: base UTXO ancestry (each input) + TX1 itself.
    const beef = new Beef();
    for (const fi of sel.feeInputs) beef.mergeBeef(fi.beef);
    beef.mergeTransaction(sdkTx);
    const fundingBeef = beef.toBinaryAtomic(txid);

    return { ok: true, funding: { txid, vout: 0, scriptHex: baseScriptHex, satoshis: outputSats }, fundingRawTx, fundingBeef, changeSats };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
