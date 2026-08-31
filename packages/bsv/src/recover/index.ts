/**
 * Sweep a coin the wallet can DERIVE but has never ADOPTED.
 *
 * Paying to an address derived from someone's own master key does not put the sats in
 * their wallet. Until `internalizeAction` runs, the output is in no basket, in no
 * balance and selectable by nothing — the owner's money, invisible to the owner. This
 * recovers such an output: it spends it with the derivation that locked it, pays the
 * proceeds to a fresh BRC-29 self-payment, and hands back what the caller needs to
 * internalise the result so the funds finally land in the spendable balance.
 *
 * Written for the pre-ADR-035 pledge refunds, which were paid to a STAS-protocol
 * ownership key and stranded there. It is deliberately general: the same shape recovers
 * any output locked to a derivation the wallet owns.
 *
 * Non-custodial: only the owner's wallet can sign, and the proceeds can go nowhere but
 * back to that same wallet.
 */
import type { WalletInterface, WalletProtocol } from '@bsv/sdk';
import { Transaction, Beef, PublicKey, P2PKH, PrivateKey, createNonce } from '@bsv/sdk';
import { signP2pkhInput } from '../settle/twoTx/p2pkhInput';

const ORIGINATOR = 'launchpad.recover';
const SIGHASH_ALL_FORKID = 0x41;

export interface StrandedOutput {
  txid: string;
  vout: number;
  satoshis: number;
  /** The output's locking script. Must be P2PKH to the derived key below. */
  scriptHex: string;
}

export interface RecoverArgs {
  utxo: StrandedOutput;
  /** The derivation the output was locked to — how the wallet re-derives the key. */
  derivation: { protocolID: WalletProtocol; keyID: string; counterparty: 'self' | 'anyone' | string; forSelf?: boolean };
  feeSats: number;
  /** BEEF ancestry of the stranded output's own transaction. */
  sourceBeef: number[];
}

export type RecoverOutcome =
  | {
      ok: true;
      rawTx: string;
      txid: string;
      recoveredSats: number;
      refund: { atomicBeef: number[]; outputIndex: number; derivationPrefix: string; derivationSuffix: string };
    }
  | { ok: false; reason: string };

async function loadBsv(): Promise<any> {
  const m: any = await import('bsv');
  return m.default ?? m;
}

export async function recoverDerivedOutput(
  wallet: WalletInterface,
  chain: 'main' | 'test',
  args: RecoverArgs,
): Promise<RecoverOutcome> {
  let bsv: any;
  try {
    bsv = await loadBsv();
  } catch (e) {
    return { ok: false, reason: `load bsv: ${msg(e)}` };
  }

  const recovered = args.utxo.satoshis - args.feeSats;
  if (recovered <= 0) {
    return { ok: false, reason: `fee ${args.feeSats} leaves nothing of ${args.utxo.satoshis} sats` };
  }

  try {
    // Refuse early if the wallet's derived key does not actually own this output —
    // otherwise the failure surfaces as an opaque script error at broadcast.
    const { publicKey: ownerPub } = await wallet.getPublicKey({ ...args.derivation } as any, ORIGINATOR);
    const ownerPkh = bsv.crypto.Hash.sha256ripemd160(
      bsv.PublicKey.fromString(ownerPub).toBuffer(),
    ).toString('hex');
    if (args.utxo.scriptHex.toLowerCase() !== `76a914${ownerPkh}88ac`) {
      return { ok: false, reason: 'that derivation does not unlock this output — wrong keyID or counterparty' };
    }

    // Destination: a fresh BRC-29 payment this wallet can take custody of.
    const derivationPrefix = await createNonce(wallet, 'self', ORIGINATOR);
    const derivationSuffix = await createNonce(wallet, 'self', ORIGINATOR);
    const { publicKey: destPub } = await wallet.getPublicKey(
      {
        protocolID: [2, '3241645161d8'] as WalletProtocol,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: 'anyone',
        forSelf: true,
      } as any,
      ORIGINATOR,
    );
    const destAddress = PublicKey.fromString(destPub).toAddress(chain === 'main' ? 'mainnet' : 'testnet');
    const destScriptHex = new P2PKH().lock(destAddress).toHex();

    const tx = new bsv.Transaction();
    tx.from({
      txId: args.utxo.txid,
      outputIndex: args.utxo.vout,
      script: args.utxo.scriptHex,
      satoshis: args.utxo.satoshis,
    });
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(destScriptHex), satoshis: recovered }));
    tx.inputs[0].output = new bsv.Transaction.Output({
      script: bsv.Script.fromHex(args.utxo.scriptHex),
      satoshis: args.utxo.satoshis,
    });

    const unlock = await signP2pkhInput({
      wallet,
      bsv,
      tx,
      inputIndex: 0,
      derivationPrefix: '',
      derivationSuffix: '',
      sourceScriptHex: args.utxo.scriptHex,
      sourceSatoshis: args.utxo.satoshis,
      sighashType: SIGHASH_ALL_FORKID,
      originator: ORIGINATOR,
      derivationOverride: args.derivation,
    });
    tx.inputs[0].setScript(bsv.Script.fromHex(unlock));

    const rawTx = tx.toString();
    const sdkTx = Transaction.fromHex(rawTx);
    const txid = sdkTx.id('hex') as string;

    let atomicBeef: number[];
    try {
      const beef = Beef.fromBinary(args.sourceBeef);
      beef.mergeTransaction(sdkTx);
      atomicBeef = beef.toBinaryAtomic(txid);
    } catch (e) {
      return { ok: false, reason: `recovery BEEF assembly: ${msg(e)}` };
    }

    return {
      ok: true,
      rawTx,
      txid,
      recoveredSats: recovered,
      refund: { atomicBeef, outputIndex: 0, derivationPrefix, derivationSuffix },
    };
  } catch (e) {
    return { ok: false, reason: `recovery build: ${msg(e)}` };
  }
}

/** Take custody of a recovered output so it becomes ordinary spendable balance. */
export async function internalizeRecovered(
  wallet: WalletInterface,
  refund: { atomicBeef: number[]; outputIndex: number; derivationPrefix: string; derivationSuffix: string },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res: any = await wallet.internalizeAction(
      {
        tx: refund.atomicBeef,
        description: 'recovered stranded output',
        labels: ['launchpad', 'recovery'],
        outputs: [
          {
            outputIndex: refund.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey: new PrivateKey(1).toPublicKey().toString(),
              derivationPrefix: refund.derivationPrefix,
              derivationSuffix: refund.derivationSuffix,
            },
          },
        ],
      } as any,
      ORIGINATOR,
    );
    if (res?.accepted === false) return { ok: false, reason: 'the wallet declined the output' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `internalize: ${msg(e)}` };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
