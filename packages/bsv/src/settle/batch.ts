/// <reference path="../vendor.d.ts" />

/**
 * Batch STAS settlement — deliver tokens to MANY recipients in ONE pool hop.
 *
 * The single-recipient `transferStas` spends the pool → [recipient, token-change,
 * BSV-change]. This spends the pool ONCE → [recipient₁ … recipientₙ, token-change,
 * BSV-change]: N token outputs plus at most one token-change and exactly one BSV
 * change (STAS's single-BSV-change rule). Turns N sequential settles (each moving
 * the pool) into a single transaction — the right tool for an escrow presale with
 * many contributors. Non-custodial: the project's wallet signs the token input.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Beef, Transaction } from '@bsv/sdk';
import { createTokenFundingOutput } from './twoTx/fundingOutput';
import { deriveSelfBrc29P2pkh } from './twoTx/brc29Address';
import { signP2pkhInput } from './twoTx/p2pkhInput';
import { buildChainedAtomicBeef } from './beef';

const STAS_PROTOCOL_ID: any = [2, '3241645161d8'];
const STAS_COUNTERPARTY = 'self';
const ORIGINATOR = 'launchpad.settle.batch';

async function loadStasDeps(): Promise<{ bsv: any; stas: any; SIGHASH: number }> {
  const bsvMod: any = await import('bsv');
  const bsv = bsvMod.default ?? bsvMod;
  const stasMod: any = await import('stas-js/lib/stas.js');
  const stas = stasMod.default ?? stasMod;
  return { bsv, stas, SIGHASH: stas.sighash };
}

export interface BatchRecipient {
  address: string;
  amount: number;
}

export interface BatchStasSource {
  txid: string;
  vout: number;
  scriptHex: string;
  satoshis: number;
  brc42KeyId: string;
  owner?: { protocolID?: any; keyID?: string; counterparty?: any; forSelf?: boolean };
  beef?: number[];
}

export interface BatchArgs {
  source: BatchStasSource;
  recipients: BatchRecipient[];
  senderChangeHash160?: string;
}

export type BatchResult =
  | { ok: true; txid: string; beef: number[]; rawTx: string; fundingRawTx: string; fundingTxid: string }
  | { ok: false; reason: string };

export async function batchTransferStas(
  wallet: WalletInterface,
  _identityKey: string,
  chain: 'main' | 'test',
  args: BatchArgs,
): Promise<BatchResult> {
  const { source, recipients } = args;
  if (!recipients.length) return { ok: false, reason: 'no recipients' };

  let bsv: any, stas: any, SIGHASH: number;
  try {
    ({ bsv, stas, SIGHASH } = await loadStasDeps());
  } catch (err) {
    return { ok: false, reason: `load stas-js/bsv failed: ${errMsg(err)}` };
  }
  const { updateStasScript, partialSTASUnlockingScript, getVersion } = stas;

  const ownerDerivation = {
    protocolID: (source.owner?.protocolID ?? STAS_PROTOCOL_ID) as any,
    keyID: source.owner?.keyID ?? source.brc42KeyId,
    counterparty: (source.owner?.counterparty ?? STAS_COUNTERPARTY) as any,
    forSelf: source.owner?.forSelf === true,
  };

  let ownerPubKey: any;
  try {
    const { publicKey } = await wallet.getPublicKey({ ...ownerDerivation } as any, ORIGINATOR);
    ownerPubKey = bsv.PublicKey.fromString(publicKey);
  } catch (err) {
    return { ok: false, reason: `getPublicKey: ${errMsg(err)}` };
  }

  // Validate STAS shape.
  const sh = source.scriptHex;
  if (typeof sh !== 'string' || sh.length < 56) return { ok: false, reason: 'source.scriptHex missing/too short' };
  if (!sh.startsWith('76a914')) return { ok: false, reason: `not a classic STAS script (prefix ${sh.substring(0, 20)}…)` };
  if (sh.substring(46, 52) !== '88ac69') return { ok: false, reason: `STAS engine marker missing (got ${sh.substring(46, 52)})` };

  // Recipient pkhs + amounts.
  let recPkhs: string[];
  try {
    recPkhs = recipients.map((r) => bsv.Address.fromString(r.address).hashBuffer.toString('hex'));
  } catch (err) {
    return { ok: false, reason: `invalid recipient address: ${errMsg(err)}` };
  }
  const totalSend = recipients.reduce((s, r) => s + Math.floor(r.amount), 0);
  const changeAmt = source.satoshis - totalSend;
  if (recipients.some((r) => !Number.isInteger(r.amount) || r.amount < 1)) return { ok: false, reason: 'each amount must be ≥ 1' };
  if (changeAmt < 0) return { ok: false, reason: `total ${totalSend} exceeds pool ${source.satoshis}` };
  if (changeAmt > 0 && !args.senderChangeHash160) return { ok: false, reason: 'partial batch requires senderChangeHash160' };

  // New STAS scripts: one per recipient + one token-change.
  let recScripts: string[], changeStasScriptHex: string | null = null, stasVersion: number;
  try {
    recScripts = recPkhs.map((pkh) => updateStasScript(pkh, sh));
    if (changeAmt > 0 && args.senderChangeHash160) changeStasScriptHex = updateStasScript(args.senderChangeHash160, sh);
    stasVersion = getVersion(sh);
  } catch (err) {
    return { ok: false, reason: `script build: ${errMsg(err)}` };
  }

  let tokenBeef: number[];
  try {
    tokenBeef = source.beef && source.beef.length > 0 ? source.beef : (await buildChainedAtomicBeef({ wallet, txid: source.txid })).beef;
  } catch (err) {
    return { ok: false, reason: `inputBEEF assembly: ${errMsg(err)}` };
  }

  let changeDeriv;
  try {
    changeDeriv = await deriveSelfBrc29P2pkh({ wallet, chain, originator: ORIGINATOR });
  } catch (err) {
    return { ok: false, reason: `change derivation: ${errMsg(err)}` };
  }

  // Fee scales with the number of token outputs.
  const FEE_RATE = 0.05;
  const MIN_FEE = 40;
  const recScriptBytes = recScripts.reduce((s, x) => s + Math.ceil(x.length / 2) + 12, 0);
  const estSize = 1700 + recScriptBytes + (changeStasScriptHex ? Math.ceil(changeStasScriptHex.length / 2) : 0) + 34;
  const tx2Fee = Math.max(MIN_FEE, Math.ceil(estSize * FEE_RATE));
  const fundingSats = tx2Fee + 500;
  let funding;
  try {
    funding = await createTokenFundingOutput({ wallet, chain, satoshis: fundingSats, originator: ORIGINATOR, description: 'batch settle funding' });
  } catch (err) {
    return { ok: false, reason: `funding: ${errMsg(err)}` };
  }
  const changeValue = funding.satoshis - tx2Fee;
  if (changeValue < 1) return { ok: false, reason: `funding ${funding.satoshis} below fee ${tx2Fee}` };

  let fundingRawTx = '';
  try {
    const fb = Beef.fromBinary(funding.beef);
    const fbt = fb.findTxid(funding.txid);
    fundingRawTx = fbt?.tx ? fbt.tx.toHex() : '';
  } catch {
    fundingRawTx = '';
  }

  // Assemble: [token(0), funding(1)] → [rec₁ … recₙ, (token-change), BSV-change].
  let tx: any;
  try {
    tx = new bsv.Transaction();
    tx.from({ txId: source.txid, outputIndex: source.vout, script: source.scriptHex, satoshis: source.satoshis });
    tx.from({ txId: funding.txid, outputIndex: funding.vout, script: funding.scriptHex, satoshis: funding.satoshis });
    recipients.forEach((r, i) => {
      tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(recScripts[i] as string), satoshis: r.amount }));
    });
    if (changeStasScriptHex != null) tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeStasScriptHex), satoshis: changeAmt }));
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeDeriv.scriptHex), satoshis: changeValue }));
    tx.inputs[0].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(source.scriptHex), satoshis: source.satoshis });
    tx.inputs[1].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(funding.scriptHex), satoshis: funding.satoshis });
  } catch (err) {
    return { ok: false, reason: `assembly: ${errMsg(err)}` };
  }

  // STAS unlock — same output order as above.
  try {
    const outs = [
      ...recipients.map((r, i) => ({ satoshis: r.amount, publicKey: recPkhs[i] as string })),
      changeStasScriptHex != null && args.senderChangeHash160 ? { satoshis: changeAmt, publicKey: args.senderChangeHash160 } : null,
      { satoshis: changeValue, publicKey: changeDeriv.pkhHex },
    ];
    partialSTASUnlockingScript(tx, outs, stasVersion, false);
  } catch (err) {
    return { ok: false, reason: `partial unlocking: ${errMsg(err)}` };
  }

  try {
    const sourceLocking = bsv.Script.fromHex(source.scriptHex);
    const satsBN = new bsv.crypto.BN(source.satoshis);
    const preimage = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH, 0, sourceLocking, satsBN);
    const digestBytes = Array.from(bsv.crypto.Hash.sha256sha256(preimage) as Buffer) as number[];
    const sigRes = await wallet.createSignature(
      { protocolID: ownerDerivation.protocolID, keyID: ownerDerivation.keyID, counterparty: ownerDerivation.counterparty, hashToDirectlySign: digestBytes } as any,
      ORIGINATOR,
    );
    const tokenSigHex = toHex(sigRes.signature) + SIGHASH.toString(16).padStart(2, '0');
    const partialASM = tx.inputs[0].script.toASM();
    tx.inputs[0].setScript(bsv.Script.fromASM(`${partialASM} ${tokenSigHex} ${ownerPubKey.toString('hex')}`));
  } catch (err) {
    return { ok: false, reason: `sign token input: ${errMsg(err)}` };
  }

  try {
    const fundingUnlock = await signP2pkhInput({
      wallet, bsv, tx, inputIndex: 1,
      derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH, originator: ORIGINATOR,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(fundingUnlock));
  } catch (err) {
    return { ok: false, reason: `sign funding input: ${errMsg(err)}` };
  }

  const rawTx = tx.toString();
  let tx2Txid = '', tx2AtomicBeef: number[];
  try {
    const beef = Beef.fromBinary(tokenBeef);
    beef.mergeBeef(Beef.fromBinary(funding.beef));
    const sdkTx2 = Transaction.fromHex(rawTx);
    beef.mergeTransaction(sdkTx2);
    tx2Txid = sdkTx2.id('hex');
    tx2AtomicBeef = beef.toBinaryAtomic(tx2Txid);
  } catch (err) {
    return { ok: false, reason: `BEEF assembly: ${errMsg(err)}` };
  }

  return { ok: true, txid: tx2Txid, beef: tx2AtomicBeef, rawTx, fundingRawTx, fundingTxid: funding.txid };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function toHex(bytes: number[] | Uint8Array): string {
  return (Array.isArray(bytes) ? bytes : Array.from(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
