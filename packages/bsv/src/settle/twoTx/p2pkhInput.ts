/**
 * signP2pkhInput — sign a plain P2PKH input via `wallet.createSignature`.
 * Ported from stas-knowledge-mcp (two-tx-spend). Part of the storage-agnostic
 * two-tx STAS transfer: TX2's funding input spends a BRC-29 self-address output
 * TX1 created; the wallet won't sign a caller-supplied input during signAction,
 * so we build the sighash preimage (bsv-js), double-sha256 it, and sign the
 * digest with the same derivation triple used to lock it.
 */
import type { WalletInterface, WalletProtocol } from '@bsv/sdk';

/** BRC-29 ("SABPPP") payment protocol id — matches our STAS owner derivation. */
export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8'];

export interface SignP2pkhInputArgs {
  wallet: WalletInterface;
  bsv: any;
  tx: any;
  inputIndex: number;
  derivationPrefix: string;
  derivationSuffix: string;
  sourceScriptHex: string;
  sourceSatoshis: number;
  sighashType: number;
  originator: string;
  /**
   * Override the key this input is signed with. Defaults to the BRC-29 triple the
   * two-tx flow locks its funding output to. Needed to spend a coin locked to some
   * OTHER derivation the wallet owns — e.g. sweeping an output that was paid to a
   * derived address and never adopted, where the original keyID was not a BRC-29
   * nonce pair.
   */
  derivationOverride?: { protocolID: WalletProtocol; keyID: string; counterparty: 'self' | 'anyone' | string; forSelf?: boolean };
}

/** Returns the funding input's unlocking script hex (`<DER sig + sighash> <pubkey>`). */
export async function signP2pkhInput(args: SignP2pkhInputArgs): Promise<string> {
  const {
    wallet,
    bsv,
    tx,
    inputIndex,
    derivationPrefix,
    derivationSuffix,
    sourceScriptHex,
    sourceSatoshis,
    sighashType,
    originator,
  } = args;

  const derivation = args.derivationOverride ?? {
    protocolID: BRC29_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: 'anyone' as const,
    forSelf: true,
  };

  const { publicKey } = await wallet.getPublicKey({ ...derivation } as any, originator);

  const sourceLocking = bsv.Script.fromHex(sourceScriptHex);
  const satsBN = new bsv.crypto.BN(sourceSatoshis);
  const preimage = bsv.Transaction.sighash.sighashPreimage(tx, sighashType, inputIndex, sourceLocking, satsBN);
  const digest = Array.from(bsv.crypto.Hash.sha256sha256(preimage) as Buffer) as number[];

  const sigRes = await wallet.createSignature({ ...derivation, hashToDirectlySign: digest } as any, originator);
  const sigHex =
    Buffer.from(sigRes.signature as number[]).toString('hex') + sighashType.toString(16).padStart(2, '0');

  return bsv.Script.fromASM(`${sigHex} ${publicKey}`).toHex();
}
