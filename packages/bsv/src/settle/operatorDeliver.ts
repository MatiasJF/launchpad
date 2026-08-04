/// <reference path="../vendor.d.ts" />

/**
 * operatorDeliverStas — TX-B of the Option-B "stas" bonding-curve buy (ADR-028).
 *
 * After a buyer funds the reserve buy (TX-A), the OPERATOR delivers `amount` STAS
 * from the operator vault to the buyer. This mirrors the proven single-recipient
 * two-tx transfer (settle/index.ts `transferStas`), with two differences:
 *   (1) the STAS token input is owned by the operator's FLAT key (the vault = a base
 *       P2PKH whose owner pkh is hash160(operator pubkey), minted in step 1), NOT a
 *       BRC-42 wallet key — so it is signed by a caller-supplied raw ECDSA signer over
 *       the sighash digest rather than `wallet.createSignature`.
 *   (2) the tx FEE no longer comes from a `@bsv/wallet-toolbox` custody wallet + a
 *       separate TX1 funding output. Instead the operator funds the fee DIRECTLY from
 *       spendable sats at its own BASE P2PKH address (flat key), passed in as
 *       `feeInputs` (see operatorBaseFunding.selectOperatorFeeInputs). BSV change goes
 *       straight back to the base address as the delivery tx's last output. This drops
 *       the toolbox off the hot delivery path (ADR-028 revised): the toolbox custody's
 *       remote storage rejected every createAction once the operator held a chain of
 *       unconfirmed txs. See operatorBaseFunding.ts.
 *
 * Delivery tx shape:
 *   inputs : [ token (flat-key), operator base fee input(s) (flat-key P2PKH) ]
 *   outputs: [ recipient STAS, (token-change back to vault), BSV-change to base ]
 *
 * Non-broadcasting: this only ASSEMBLES + signs and returns an ATOMIC BEEF whose tip is
 * the delivery tx and whose leaves are BOTH ancestries (token + every fee input),
 * anchored to confirmed roots. The caller flushes that whole unconfirmed chain to WoC
 * (parents-first, multi-pass) — no separate TX1 to broadcast first.
 */
import { Beef, Transaction } from '@bsv/sdk';
import { signOperatorP2pkhInput, p2pkhScriptHexForPkh, type OperatorFeeInput } from './operatorBaseFunding';

const ORIGINATOR = 'launchpad.stas.deliver';

async function loadStasDeps(): Promise<{ bsv: any; stas: any; SIGHASH: number }> {
  const bsvMod: any = await import('bsv');
  const bsv = bsvMod.default ?? bsvMod;
  const stasMod: any = await import('stas-js/lib/stas.js');
  const stas = stasMod.default ?? stasMod;
  return { bsv, stas, SIGHASH: stas.sighash };
}

export interface OperatorDeliverSource {
  txid: string;
  vout: number;
  scriptHex: string; // the vault STAS locking script (76a914 <operatorPkh> 88ac69 …)
  satoshis: number; // the vault's current token amount
  beef?: number[]; // from-chain ancestry BEEF for the vault UTXO (SPV anchor)
}

export interface OperatorDeliverArgs {
  chain: 'main' | 'test';
  /** The vault STAS UTXO the delivery spends. */
  source: OperatorDeliverSource;
  /** Buyer's STAS receive address. */
  recipientAddress: string;
  /** Tokens to deliver. */
  amount: number;
  /** hash160 (hex) of the operator vault owner — token change re-locks here. */
  vaultChangeHash160: string;
  /** Operator public key (hex) whose hash160 owns the vault STAS input. */
  tokenOwnerPubHex: string;
  /** Raw ECDSA signer for the token input: sha256sha256(preimage) digest hex -> low-S DER sig hex. */
  signTokenDigest: (digestHex: string) => Promise<string>;
  /** Operator base-address fee input(s) (flat-key P2PKH), ancestry-anchored. */
  feeInputs: OperatorFeeInput[];
  /** hash160 (hex) of the operator base address — the delivery's BSV change re-locks here. */
  baseChangeHash160: string;
  /** Operator public key (hex) whose hash160 owns the base fee input(s). */
  feeOwnerPubHex: string;
  /** Raw ECDSA signer for the fee input(s): digest hex -> low-S DER sig hex (operatorSignDigest). */
  signFeeDigest: (digestHex: string) => Promise<string>;
  originator?: string;
}

export type OperatorDeliverResult =
  | {
      ok: true;
      txid: string;
      /** Atomic BEEF whose tip is the delivery tx (token + fee ancestries merged). */
      beef: number[];
      rawTx: string;
      /** The token-change output back to the vault (new vault), or null if fully spent. */
      newVault: { txid: string; vout: number; scriptHex: string; satoshis: number } | null;
    }
  | { ok: false; reason: string };

export async function operatorDeliverStas(args: OperatorDeliverArgs): Promise<OperatorDeliverResult> {
  const {
    chain: _chain,
    source,
    recipientAddress,
    amount,
    vaultChangeHash160,
    tokenOwnerPubHex,
    signTokenDigest,
    feeInputs,
    baseChangeHash160,
    feeOwnerPubHex,
    signFeeDigest,
    originator = ORIGINATOR,
  } = args;

  let bsv: any, stas: any, SIGHASH: number;
  try {
    ({ bsv, stas, SIGHASH } = await loadStasDeps());
  } catch (err) {
    return { ok: false, reason: `load stas-js/bsv failed: ${errMsg(err)}` };
  }
  const { updateStasScript, partialSTASUnlockingScript, getVersion } = stas;

  // Operator vault owner pubkey.
  let ownerPubKey: any;
  try {
    ownerPubKey = bsv.PublicKey.fromString(tokenOwnerPubHex);
  } catch (err) {
    return { ok: false, reason: `invalid tokenOwnerPubHex: ${errMsg(err)}` };
  }

  if (!Array.isArray(feeInputs) || feeInputs.length === 0) return { ok: false, reason: 'feeInputs required (operator base fee)' };
  if (!/^[0-9a-fA-F]{40}$/.test(baseChangeHash160)) return { ok: false, reason: 'baseChangeHash160 must be a 20-byte pkh hex' };

  // Recipient hash160.
  let recipientPkhHex: string;
  try {
    recipientPkhHex = bsv.Address.fromString(recipientAddress).hashBuffer.toString('hex');
  } catch (err) {
    return { ok: false, reason: `invalid recipient: ${errMsg(err)}` };
  }

  // Validate STAS shape.
  const sh = source.scriptHex;
  if (typeof sh !== 'string' || sh.length < 56) return { ok: false, reason: 'source.scriptHex missing/too short' };
  if (!sh.startsWith('76a914')) return { ok: false, reason: `not a classic STAS script (prefix ${sh.substring(0, 20)}…)` };
  if (sh.substring(46, 52) !== '88ac69') return { ok: false, reason: `STAS engine marker missing (got ${sh.substring(46, 52)})` };

  // Full vs partial send (partial: token change back to the vault).
  const sendAmt = Math.floor(amount);
  const changeAmt = source.satoshis - sendAmt;
  if (!Number.isInteger(sendAmt) || sendAmt < 1) return { ok: false, reason: `invalid amount ${sendAmt}` };
  if (changeAmt < 0) return { ok: false, reason: `amount ${sendAmt} exceeds vault ${source.satoshis}` };

  // New STAS scripts: recipient + (token-change back to the vault).
  let newStasScriptHex: string, changeStasScriptHex: string | null = null, stasVersion: number;
  try {
    newStasScriptHex = updateStasScript(recipientPkhHex, sh);
    if (changeAmt > 0) changeStasScriptHex = updateStasScript(vaultChangeHash160, sh);
    stasVersion = getVersion(sh);
  } catch (err) {
    return { ok: false, reason: `script build: ${errMsg(err)}` };
  }

  // Token input ancestry BEEF (SPV) — must be supplied from-chain (the flat-key
  // vault isn't tracked in any wallet basket).
  if (!source.beef || source.beef.length === 0) return { ok: false, reason: 'source.beef required (from-chain vault ancestry)' };
  const tokenBeef = source.beef;

  // Fee sizing: the delivery tx is [token + N fee inputs] → [recipient, (token-change), BSV-change].
  // Size from the ACTUAL output script lengths (the STAS outputs are the large ones —
  // counted explicitly, not flattened to 34 B) plus a generous budget for the STAS
  // token input's unlocking script (partial-STAS pushes + sig + pubkey can exceed a
  // plain 148-B P2PKH input). This tx HAS a BSV-change output, so any over-estimate is
  // simply absorbed as a smaller change (never an underpay). 0.1 sat/byte, floored.
  const FEE_RATE = 0.1;
  const MIN_FEE = 40;
  const STAS_TOKEN_INPUT_BUDGET = 400; // safe upper bound for the STAS token unlock
  const outBytes = (len: number) => 8 + (len < 0xfd ? 1 : len <= 0xffff ? 3 : 5) + len;
  const estSize =
    4 /* version */ + 4 /* locktime */ + 3 /* varint in/out counts */ +
    STAS_TOKEN_INPUT_BUDGET + feeInputs.length * 148 +
    outBytes(Math.ceil(newStasScriptHex.length / 2)) +
    (changeStasScriptHex ? outBytes(Math.ceil(changeStasScriptHex.length / 2)) : 0) +
    outBytes(25) /* base P2PKH change */;
  const txFee = Math.max(MIN_FEE, Math.ceil(estSize * FEE_RATE));
  const totalFeeIn = feeInputs.reduce((s, f) => s + f.satoshis, 0);
  const changeValue = totalFeeIn - txFee;
  if (changeValue < 1) return { ok: false, reason: `fee inputs total ${totalFeeIn} below fee ${txFee} + dust` };

  // BSV-change output locks back to the operator base address (P2PKH).
  const baseChangeScriptHex = p2pkhScriptHexForPkh(baseChangeHash160);

  // Assemble: [token(0), fee(1..n)] → [recipient(0), (token-change), BSV-change(last)].
  let tx: any;
  try {
    tx = new bsv.Transaction();
    tx.from({ txId: source.txid, outputIndex: source.vout, script: source.scriptHex, satoshis: source.satoshis });
    for (const fi of feeInputs) tx.from({ txId: fi.txid, outputIndex: fi.vout, script: fi.scriptHex, satoshis: fi.satoshis });
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(newStasScriptHex), satoshis: sendAmt }));
    if (changeStasScriptHex != null) tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeStasScriptHex), satoshis: changeAmt }));
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(baseChangeScriptHex), satoshis: changeValue }));
    tx.inputs[0].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(source.scriptHex), satoshis: source.satoshis });
    for (const [i, fi] of feeInputs.entries()) {
      tx.inputs[i + 1].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(fi.scriptHex), satoshis: fi.satoshis });
    }
  } catch (err) {
    return { ok: false, reason: `TX-B assembly: ${errMsg(err)}` };
  }

  // STAS unlock — same output order.
  try {
    partialSTASUnlockingScript(
      tx,
      [
        { satoshis: sendAmt, publicKey: recipientPkhHex },
        changeStasScriptHex != null ? { satoshis: changeAmt, publicKey: vaultChangeHash160 } : null,
        { satoshis: changeValue, publicKey: baseChangeHash160 },
      ],
      stasVersion,
      false,
    );
  } catch (err) {
    return { ok: false, reason: `partial unlocking: ${errMsg(err)}` };
  }

  // Sign the token input with the OPERATOR flat key: preimage → sha256sha256 →
  // raw ECDSA (caller callback). Same digest the covenant/STAS engine checks.
  try {
    const sourceLocking = bsv.Script.fromHex(source.scriptHex);
    const satsBN = new bsv.crypto.BN(source.satoshis);
    const preimage = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH, 0, sourceLocking, satsBN);
    const digestHex = (bsv.crypto.Hash.sha256sha256(preimage) as Buffer).toString('hex');
    const der = await signTokenDigest(digestHex);
    const tokenSigHex = der + SIGHASH.toString(16).padStart(2, '0');
    const partialASM = tx.inputs[0].script.toASM();
    tx.inputs[0].setScript(bsv.Script.fromASM(`${partialASM} ${tokenSigHex} ${ownerPubKey.toString('hex')}`));
  } catch (err) {
    return { ok: false, reason: `sign token input (operator): ${errMsg(err)}` };
  }

  // Sign each operator base fee input (P2PKH) with the flat key (raw ECDSA callback).
  try {
    for (const [i, fi] of feeInputs.entries()) {
      const unlock = await signOperatorP2pkhInput({
        bsv, tx, inputIndex: i + 1,
        sourceScriptHex: fi.scriptHex, sourceSatoshis: fi.satoshis, sighashType: SIGHASH,
        operatorPubHex: feeOwnerPubHex, signFeeDigest,
      });
      tx.inputs[i + 1].setScript(bsv.Script.fromHex(unlock));
    }
  } catch (err) {
    return { ok: false, reason: `sign fee input (operator base): ${errMsg(err)}` };
  }

  const rawTx = tx.toString();
  let tx2Txid = '', tx2AtomicBeef: number[];
  try {
    const beef = Beef.fromBinary(tokenBeef);
    for (const fi of feeInputs) beef.mergeBeef(fi.beef);
    const sdkTx2 = Transaction.fromHex(rawTx);
    beef.mergeTransaction(sdkTx2);
    tx2Txid = sdkTx2.id('hex');
    tx2AtomicBeef = beef.toBinaryAtomic(tx2Txid);
  } catch (err) {
    return { ok: false, reason: `TX-B BEEF assembly: ${errMsg(err)}` };
  }

  const newVault =
    changeStasScriptHex != null
      ? { txid: tx2Txid, vout: 1, scriptHex: changeStasScriptHex, satoshis: changeAmt }
      : null;

  void originator;
  void _chain;
  return { ok: true, txid: tx2Txid, beef: tx2AtomicBeef, rawTx, newVault };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
