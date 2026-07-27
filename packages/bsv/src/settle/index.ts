/// <reference path="../vendor.d.ts" />

/**
 * STAS settlement — the storage-agnostic two-transaction transfer (BSV-003).
 * Ported faithfully from stas-knowledge-mcp (the proven BSV Desktop integration),
 * adapted to our canonical STAS owner protocol id (matches issuance, ADR-021).
 *
 * The seller (pool owner) transfers a token amount to a buyer's derived owner
 * address. Non-custodial: the seller's wallet signs; keys never leave it.
 *
 * STATUS: ported, NOT yet wired or live-tested. Remaining before it can run:
 *   - implement `buildChainedAtomicBeef` (see ./beef);
 *   - run client-side with bsv-js bundled for the browser (webpack polyfills);
 *   - exercise against a funded wallet holding an issued STAS UTXO.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Beef, Transaction } from '@bsv/sdk';
import { createTokenFundingOutput } from './twoTx/fundingOutput';
import { deriveSelfBrc29P2pkh } from './twoTx/brc29Address';
import { signP2pkhInput } from './twoTx/p2pkhInput';
import { broadcastAndInternalizeChange } from './twoTx/internalizeChange';
import { buildChainedAtomicBeef } from './beef';

// Our canonical STAS owner protocol id (matches packages/bsv/src/issue, ADR-021).
const STAS_PROTOCOL_ID: any = [2, '3241645161d8'];
const STAS_COUNTERPARTY = 'self';
const ORIGINATOR = 'launchpad.settle';

async function loadStasDeps(): Promise<{ bsv: any; stasInternals: any; SIGHASH: number }> {
  const bsvMod: any = await import('bsv');
  const bsv = bsvMod.default ?? bsvMod;
  const stasInternalsMod: any = await import('stas-js/lib/stas.js');
  const stasInternals = stasInternalsMod.default ?? stasInternalsMod;
  return { bsv, stasInternals, SIGHASH: stasInternals.sighash };
}

export interface StasSource {
  txid: string;
  vout: number;
  scriptHex: string;
  satoshis: number;
  brc42KeyId: string;
  owner?: { protocolID?: any; keyID?: string; counterparty?: any; forSelf?: boolean };
  /**
   * Ancestry BEEF for this token input (bytes). When provided (e.g. fetched
   * from-chain for a confirmed source, incl. its merkle proof), it is used as
   * the SPV anchor instead of the wallet's `stas-tokens` basket. This is what
   * lets us spend a pool UTXO that isn't tracked in the basket — e.g. the token
   * change from a prior transfer. Falls back to the basket when omitted.
   */
  beef?: number[];
}

export interface StasTransferArgs {
  source: StasSource;
  recipientAddress: string;
  amount?: number;
  senderChangeHash160?: string;
  senderChangeKeyId?: string;
  tokenId?: string;
}

export type StasTransferResult =
  | { ok: true; txid: string; beef: number[]; rawTx: string }
  | { ok: false; reason: string; rawTx?: string };

export async function transferStas(
  wallet: WalletInterface,
  identityKey: string,
  chain: 'main' | 'test',
  args: StasTransferArgs,
): Promise<StasTransferResult> {
  const { source, recipientAddress } = args;

  let bsv: any, stasInternals: any, SIGHASH: number;
  try {
    ({ bsv, stasInternals, SIGHASH } = await loadStasDeps());
  } catch (err) {
    return { ok: false, reason: `load stas-js/bsv failed: ${errMsg(err)}` };
  }
  const { updateStasScript, partialSTASUnlockingScript, getVersion } = stasInternals;

  const ownerDerivation = {
    protocolID: (source.owner?.protocolID ?? STAS_PROTOCOL_ID) as any,
    keyID: source.owner?.keyID ?? source.brc42KeyId,
    counterparty: (source.owner?.counterparty ?? STAS_COUNTERPARTY) as any,
    forSelf: source.owner?.forSelf === true,
  };

  // 1. Owner pubkey via BRC-42 derivation.
  let ownerPubKey: any;
  try {
    const { publicKey } = await wallet.getPublicKey({ ...ownerDerivation } as any, ORIGINATOR);
    ownerPubKey = bsv.PublicKey.fromString(publicKey);
  } catch (err) {
    return { ok: false, reason: `getPublicKey: ${errMsg(err)}` };
  }

  // 2. Recipient hash160.
  let recipientPkhHex: string;
  try {
    recipientPkhHex = bsv.Address.fromString(recipientAddress).hashBuffer.toString('hex');
  } catch (err) {
    return { ok: false, reason: `invalid recipient: ${errMsg(err)}` };
  }

  // 3. Validate the source is a classic STAS shape (76a914 <owner> 88ac69 …).
  const sh = source.scriptHex;
  if (typeof sh !== 'string' || sh.length < 56) return { ok: false, reason: 'source.scriptHex missing/too short' };
  if (!sh.startsWith('76a914'))
    return { ok: false, reason: `not a classic STAS script (prefix ${sh.substring(0, 20)}…)` };
  if (sh.substring(46, 52) !== '88ac69')
    return { ok: false, reason: `STAS engine marker missing at offset 46 (got ${sh.substring(46, 52)})` };

  // 3b. Full vs partial send.
  const sendAmt = args.amount ?? source.satoshis;
  const changeAmt = source.satoshis - sendAmt;
  if (!Number.isInteger(sendAmt) || sendAmt < 1) return { ok: false, reason: `invalid amount ${sendAmt}` };
  if (changeAmt < 0) return { ok: false, reason: `amount ${sendAmt} exceeds UTXO value ${source.satoshis}` };
  if (changeAmt > 0 && !args.senderChangeHash160)
    return { ok: false, reason: 'partial transfer requires senderChangeHash160' };

  // 4. New STAS locking script(s) — updateStasScript mutates ONLY the owner pkh.
  let newStasScriptHex: string,
    changeStasScriptHex: string | null = null,
    stasVersion: number;
  try {
    newStasScriptHex = updateStasScript(recipientPkhHex, sh);
    if (changeAmt > 0 && args.senderChangeHash160)
      changeStasScriptHex = updateStasScript(args.senderChangeHash160, sh);
    stasVersion = getVersion(sh);
  } catch (err) {
    return { ok: false, reason: `script build: ${errMsg(err)}` };
  }

  // 5. Token input ancestry BEEF (SPV). Prefer a caller-supplied from-chain BEEF
  //    (works for any confirmed pool UTXO); fall back to the wallet basket.
  let tokenBeef: number[];
  try {
    tokenBeef =
      source.beef && source.beef.length > 0
        ? source.beef
        : (await buildChainedAtomicBeef({ wallet, txid: source.txid })).beef;
  } catch (err) {
    return { ok: false, reason: `inputBEEF assembly: ${errMsg(err)}` };
  }

  // 6. Self-owned BRC-29 address for TX2's single BSV change output.
  let changeDeriv;
  try {
    changeDeriv = await deriveSelfBrc29P2pkh({ wallet, chain, originator: ORIGINATOR });
  } catch (err) {
    return { ok: false, reason: `change derivation: ${errMsg(err)}` };
  }

  // 7. TX1: funding output sized to TX2's fee.
  const FEE_RATE = 1;
  const estTx2Size =
    5500 +
    120 +
    200 +
    Math.ceil(newStasScriptHex.length / 2) +
    (changeStasScriptHex ? Math.ceil(changeStasScriptHex.length / 2) : 0) +
    34;
  const tx2Fee = Math.ceil(estTx2Size * FEE_RATE);
  const fundingSats = tx2Fee + 500;
  let funding;
  try {
    funding = await createTokenFundingOutput({
      wallet,
      chain,
      satoshis: fundingSats,
      originator: ORIGINATOR,
      description: 'STAS transfer funding',
    });
  } catch (err) {
    return { ok: false, reason: `TX1 funding: ${errMsg(err)}` };
  }
  const changeValue = funding.satoshis - tx2Fee;
  if (changeValue < 1) return { ok: false, reason: `funding ${funding.satoshis} below fee ${tx2Fee}` };

  // 8. Assemble TX2: [token(0), funding(1)] → [recipient(0), (token-change), change].
  let tx: any;
  try {
    tx = new bsv.Transaction();
    tx.from({ txId: source.txid, outputIndex: source.vout, script: source.scriptHex, satoshis: source.satoshis });
    tx.from({ txId: funding.txid, outputIndex: funding.vout, script: funding.scriptHex, satoshis: funding.satoshis });
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(newStasScriptHex), satoshis: sendAmt }));
    if (changeStasScriptHex != null)
      tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeStasScriptHex), satoshis: changeAmt }));
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeDeriv.scriptHex), satoshis: changeValue }));
    tx.inputs[0].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(source.scriptHex), satoshis: source.satoshis });
    tx.inputs[1].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(funding.scriptHex), satoshis: funding.satoshis });
  } catch (err) {
    return { ok: false, reason: `TX2 assembly: ${errMsg(err)}` };
  }
  const changeVout = tx.outputs.length - 1;

  // 9. STAS unlock for the token input.
  try {
    partialSTASUnlockingScript(
      tx,
      [
        { satoshis: sendAmt, publicKey: recipientPkhHex },
        changeStasScriptHex != null && args.senderChangeHash160
          ? { satoshis: changeAmt, publicKey: args.senderChangeHash160 }
          : null,
        { satoshis: changeValue, publicKey: changeDeriv.pkhHex },
      ],
      stasVersion,
      false,
    );
  } catch (err) {
    return { ok: false, reason: `partial unlocking: ${errMsg(err)}` };
  }

  // Sign the token input: preimage → double-sha256 → wallet.createSignature.
  let tokenSigHex: string;
  try {
    const sourceLocking = bsv.Script.fromHex(source.scriptHex);
    const satsBN = new bsv.crypto.BN(source.satoshis);
    const preimage = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH, 0, sourceLocking, satsBN);
    const digestBytes = Array.from(bsv.crypto.Hash.sha256sha256(preimage) as Buffer) as number[];
    const sigRes = await wallet.createSignature(
      {
        protocolID: ownerDerivation.protocolID,
        keyID: ownerDerivation.keyID,
        counterparty: ownerDerivation.counterparty,
        hashToDirectlySign: digestBytes,
      } as any,
      ORIGINATOR,
    );
    tokenSigHex = toHex(sigRes.signature) + SIGHASH.toString(16).padStart(2, '0');
  } catch (err) {
    return { ok: false, reason: `sighash/sign token input: ${errMsg(err)}` };
  }
  try {
    const partialASM = tx.inputs[0].script.toASM();
    tx.inputs[0].setScript(bsv.Script.fromASM(`${partialASM} ${tokenSigHex} ${ownerPubKey.toString('hex')}`));
  } catch (err) {
    return { ok: false, reason: `token unlock assembly: ${errMsg(err)}` };
  }

  // 10. Sign the funding input (P2PKH).
  try {
    const fundingUnlock = await signP2pkhInput({
      wallet,
      bsv,
      tx,
      inputIndex: 1,
      derivationPrefix: funding.derivationPrefix,
      derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex,
      sourceSatoshis: funding.satoshis,
      sighashType: SIGHASH,
      originator: ORIGINATOR,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(fundingUnlock));
  } catch (err) {
    return { ok: false, reason: `sign funding input: ${errMsg(err)}` };
  }

  // 11. TX2 AtomicBEEF + raw hex.
  const rawTx = tx.toString();
  let tx2Txid = '',
    tx2AtomicBeef: number[];
  try {
    const beef = Beef.fromBinary(tokenBeef);
    beef.mergeBeef(Beef.fromBinary(funding.beef));
    const sdkTx2 = Transaction.fromHex(rawTx);
    beef.mergeTransaction(sdkTx2);
    tx2Txid = sdkTx2.id('hex');
    tx2AtomicBeef = beef.toBinaryAtomic(tx2Txid);
  } catch (err) {
    return { ok: false, reason: `TX2 BEEF assembly: ${errMsg(err)}`, rawTx };
  }

  // 12. Internalize the sender's BSV change into the wallet (best-effort book-
  //     keeping). NOTE: this does NOT reliably broadcast TX2 to miners — some
  //     wallets accept/internalize without propagating. The caller MUST treat an
  //     explicit network broadcast of `rawTx` as the source of truth for landing
  //     the transfer on-chain. We therefore never fail here; we return rawTx and
  //     let the caller broadcast + confirm.
  try {
    await broadcastAndInternalizeChange({
      wallet,
      atomicBeef: tx2AtomicBeef,
      changeVout,
      derivationPrefix: changeDeriv.derivationPrefix,
      derivationSuffix: changeDeriv.derivationSuffix,
      originator: ORIGINATOR,
      description: 'STAS transfer',
      labels: ['launchpad', 'settle'],
    });
  } catch {
    // ignore — explicit broadcast below is authoritative
  }

  return { ok: true, txid: tx2Txid, beef: tx2AtomicBeef, rawTx };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function toHex(bytes: number[] | Uint8Array): string {
  return (Array.isArray(bytes) ? bytes : Array.from(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
