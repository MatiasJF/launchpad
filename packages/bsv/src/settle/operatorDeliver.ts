/// <reference path="../vendor.d.ts" />

/**
 * operatorDeliverStas — TX-B of the Option-B "stas" bonding-curve buy (ADR-028).
 *
 * After a buyer funds the reserve buy (TX-A), the OPERATOR delivers `amount` STAS
 * from the operator vault to the buyer. This mirrors the proven single-recipient
 * two-tx transfer (settle/index.ts `transferStas`) EXACTLY, with one difference:
 * the STAS token input is owned by the operator's FLAT key (the vault = a base
 * P2PKH whose owner pkh is hash160(operator pubkey), minted in step 1), NOT a
 * BRC-42 wallet key — so it is signed by a caller-supplied raw ECDSA signer over
 * the sighash digest rather than `wallet.createSignature`.
 *
 * CUSTODY SPLIT (the design point the STAS vault forces): the minted STAS inventory
 * lives at the operator's BASE P2PKH address (flat key), while the operator's fee
 * sats live in a wallet-toolbox custody wallet. So this function takes TWO signing
 * authorities:
 *   • `feeWallet`   — the toolbox custody wallet: creates the funding output (TX1)
 *                     and signs the P2PKH fee input (input 1). This is the same
 *                     BRC-29 funding path `transferStas` uses.
 *   • `signTokenDigest` + `tokenOwnerPubHex` — the operator flat key: signs the
 *                     STAS token input (input 0). The app passes operatorSignDigest
 *                     (raw ECDSA, low-S DER) so the operator key never enters this
 *                     package.
 *
 * Non-broadcasting: like `transferStas`, this only ASSEMBLES + signs. It returns
 * `rawTx` (TX-B) + `fundingRawTx` (TX1) for the caller to broadcast explicitly
 * (TX1 first). `createTokenFundingOutput` DOES broadcast TX1 via the feeWallet's
 * createAction (operator-side) — that only happens when this function is invoked,
 * never at import/build time.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Beef, Transaction } from '@bsv/sdk';
import { createTokenFundingOutput } from './twoTx/fundingOutput';
import { deriveSelfBrc29P2pkh } from './twoTx/brc29Address';
import { signP2pkhInput } from './twoTx/p2pkhInput';

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
  /** Toolbox custody wallet — funds TX1 + signs the P2PKH fee input. */
  feeWallet: WalletInterface;
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
  /** Raw ECDSA signer: sha256sha256(preimage) digest hex -> low-S DER sig hex. */
  signTokenDigest: (digestHex: string) => Promise<string>;
  originator?: string;
}

export type OperatorDeliverResult =
  | {
      ok: true;
      txid: string;
      beef: number[];
      rawTx: string;
      fundingRawTx: string;
      fundingTxid: string;
      /** The token-change output back to the vault (new vault), or null if fully spent. */
      newVault: { txid: string; vout: number; scriptHex: string; satoshis: number } | null;
    }
  | { ok: false; reason: string };

export async function operatorDeliverStas(args: OperatorDeliverArgs): Promise<OperatorDeliverResult> {
  const { feeWallet, chain, source, recipientAddress, amount, vaultChangeHash160, tokenOwnerPubHex, signTokenDigest, originator = ORIGINATOR } = args;

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

  // Self-owned BRC-29 address for TX-B's single BSV change output (toolbox wallet).
  let changeDeriv;
  try {
    changeDeriv = await deriveSelfBrc29P2pkh({ wallet: feeWallet, chain, originator });
  } catch (err) {
    return { ok: false, reason: `change derivation: ${errMsg(err)}` };
  }

  // TX1: funding output sized to TX-B's fee (same sizing as transferStas).
  const FEE_RATE = 0.05;
  const MIN_FEE = 40;
  const estTx2Size = 1600 + 120 + 200 + Math.ceil(newStasScriptHex.length / 2) + (changeStasScriptHex ? Math.ceil(changeStasScriptHex.length / 2) : 0) + 34;
  const tx2Fee = Math.max(MIN_FEE, Math.ceil(estTx2Size * FEE_RATE));
  const fundingSats = tx2Fee + 500;
  let funding;
  try {
    funding = await createTokenFundingOutput({ wallet: feeWallet, chain, satoshis: fundingSats, originator, description: 'stas delivery funding' });
  } catch (err) {
    return { ok: false, reason: `TX1 funding: ${errMsg(err)}` };
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

  // Assemble TX-B: [token(0), funding(1)] → [recipient(0), (token-change), BSV-change].
  let tx: any;
  try {
    tx = new bsv.Transaction();
    tx.from({ txId: source.txid, outputIndex: source.vout, script: source.scriptHex, satoshis: source.satoshis });
    tx.from({ txId: funding.txid, outputIndex: funding.vout, script: funding.scriptHex, satoshis: funding.satoshis });
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(newStasScriptHex), satoshis: sendAmt }));
    if (changeStasScriptHex != null) tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeStasScriptHex), satoshis: changeAmt }));
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(changeDeriv.scriptHex), satoshis: changeValue }));
    tx.inputs[0].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(source.scriptHex), satoshis: source.satoshis });
    tx.inputs[1].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(funding.scriptHex), satoshis: funding.satoshis });
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
        { satoshis: changeValue, publicKey: changeDeriv.pkhHex },
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

  // Sign the funding input (P2PKH) with the toolbox wallet.
  try {
    const fundingUnlock = await signP2pkhInput({
      wallet: feeWallet, bsv, tx, inputIndex: 1,
      derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix,
      sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH, originator,
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
    return { ok: false, reason: `TX-B BEEF assembly: ${errMsg(err)}` };
  }

  const newVault =
    changeStasScriptHex != null
      ? { txid: tx2Txid, vout: 1, scriptHex: changeStasScriptHex, satoshis: changeAmt }
      : null;

  return { ok: true, txid: tx2Txid, beef: tx2AtomicBeef, rawTx, fundingRawTx, fundingTxid: funding.txid, newVault };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
