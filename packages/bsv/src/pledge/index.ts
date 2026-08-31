/// <reference path="../vendor.d.ts" />

/**
 * Escrow-presale pledge — SIGHASH_ANYONECANPAY dominant-assurance contract (ADR-025).
 *
 * Trustless, non-custodial intake: the contributor mints an exact-value UTXO they
 * OWN, then signs that input with `0xC1` (ANYONECANPAY | ALL | FORKID) committing
 * to a FIXED output (the soft-cap payment to the project). ANYONECANPAY means the
 * signature commits only to this input + the outputs, so pledges accumulate into
 * one assurance tx without re-signing (verified: a pledge signed alone still
 * verifies once other inputs join). The signed input is held off-chain; the
 * contributor's funds never move until the assurance tx is broadcast on success —
 * so "refund" is automatic (nothing was taken) and "emergency withdraw" is just
 * the contributor spending their own UTXO. NO broadcast happens here.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Transaction, Beef, PublicKey, P2PKH, PrivateKey, createNonce } from '@bsv/sdk';
import { createTokenFundingOutput } from '../settle/twoTx/fundingOutput';
import { BRC29_PROTOCOL_ID, signP2pkhInput } from '../settle/twoTx/p2pkhInput';

export * from './assemble';

const ORIGINATOR = 'launchpad.pledge';

/**
 * A DEDICATED basket for pledge UTXOs — deliberately not `default`.
 *
 * A basketless output is stored `basketId: undefined, change: false`: `listOutputs`
 * cannot enumerate it (it requires a basket and filters on basketId) and the wallet
 * never selects it, so the contributor's own wallet can neither see nor spend the
 * coin — which would make ADR-025's self-service refund untrue. `default` is equally
 * wrong in the other direction: the wallet draws change from it, so it could spend a
 * pledge out from under a live signature. Its own basket is the only correct answer.
 */
export const PLEDGE_BASKET = 'launchpad-pledge';
/** ANYONECANPAY (0x80) | ALL (0x01) | FORKID (0x40). Never 0x81 (no-FORKID) on BSV. */
const SIGHASH_ASSURANCE = 0xc1;
/** ALL | FORKID — an ordinary spend of the contributor's own coin. */
const SIGHASH_WITHDRAW = 0x41;

export interface PledgeArgs {
  /** The contributor's pledge UTXO value in sats (one fixed denomination unit). */
  pledgeUnitSats: number;
  /** The assurance tx's fixed output value (the soft-cap payment). */
  softCapSats: number;
  /** The assurance tx's fixed output recipient — the project payout address. */
  projectAddress: string;
}

export interface PledgeUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  derivationPrefix: string;
  derivationSuffix: string;
}

export type PledgeOutcome =
  | { ok: true; utxo: PledgeUtxo; sigHex: string; pubkeyHex: string; fundingRawTx: string }
  | { ok: false; reason: string };

async function loadBsv(): Promise<any> {
  const m: any = await import('bsv');
  return m.default ?? m;
}

export async function createPledge(
  wallet: WalletInterface,
  chain: 'main' | 'test',
  args: PledgeArgs,
): Promise<PledgeOutcome> {
  let bsv: any;
  try {
    bsv = await loadBsv();
  } catch (e) {
    return { ok: false, reason: `load bsv: ${msg(e)}` };
  }

  // 1. Mint the contributor's exact-value pledge UTXO (they own it; BRC-29 self key).
  let fund;
  try {
    fund = await createTokenFundingOutput({
      wallet,
      chain,
      satoshis: args.pledgeUnitSats,
      originator: ORIGINATOR,
      description: 'presale pledge',
      basket: PLEDGE_BASKET,
      labels: ['launchpad', 'presale-pledge'],
    });
  } catch (e) {
    return { ok: false, reason: `mint pledge UTXO: ${msg(e)}` };
  }

  // The pledge UTXO must reach the chain to be spendable in the assurance tx, so
  // return its raw tx for the caller to broadcast explicitly (createAction alone
  // does not reliably propagate — same lesson as settlement TX1).
  let fundingRawTx = '';
  try {
    const b = Beef.fromBinary(fund.beef);
    const t = b.findTxid(fund.txid);
    fundingRawTx = t?.tx ? t.tx.toHex() : '';
  } catch {
    fundingRawTx = '';
  }
  if (!fundingRawTx) return { ok: false, reason: 'could not extract pledge funding raw tx' };

  // 2. Build the assurance-tx template — [pledge input] → [softCap → project] —
  //    and sign the pledge input with 0xC1 over that fixed output.
  try {
    const recipientPkh = bsv.Address.fromString(args.projectAddress).hashBuffer.toString('hex');
    const outScript = bsv.Script.fromASM(`OP_DUP OP_HASH160 ${recipientPkh} OP_EQUALVERIFY OP_CHECKSIG`);
    const tx = new bsv.Transaction();
    tx.from({ txId: fund.txid, outputIndex: fund.vout, script: fund.scriptHex, satoshis: fund.satoshis });
    tx.addOutput(new bsv.Transaction.Output({ script: outScript, satoshis: args.softCapSats }));
    tx.inputs[0].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(fund.scriptHex), satoshis: fund.satoshis });

    const derivation = {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${fund.derivationPrefix} ${fund.derivationSuffix}`,
      counterparty: 'anyone' as const,
      forSelf: true,
    };
    const { publicKey: pubkeyHex } = await wallet.getPublicKey({ ...derivation } as any, ORIGINATOR);

    const sourceLocking = bsv.Script.fromHex(fund.scriptHex);
    const satsBN = new bsv.crypto.BN(fund.satoshis);
    const preimage = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_ASSURANCE, 0, sourceLocking, satsBN);
    const digest = Array.from(bsv.crypto.Hash.sha256sha256(preimage) as Buffer) as number[];
    const sigRes = await wallet.createSignature({ ...derivation, hashToDirectlySign: digest } as any, ORIGINATOR);
    const sigHex = Buffer.from(sigRes.signature as number[]).toString('hex') + SIGHASH_ASSURANCE.toString(16).padStart(2, '0');

    return {
      ok: true,
      utxo: {
        txid: fund.txid,
        vout: fund.vout,
        satoshis: fund.satoshis,
        scriptHex: fund.scriptHex,
        derivationPrefix: fund.derivationPrefix,
        derivationSuffix: fund.derivationSuffix,
      },
      sigHex,
      pubkeyHex,
      fundingRawTx,
    };
  } catch (e) {
    return { ok: false, reason: `pledge sign: ${msg(e)}` };
  }
}


export interface WithdrawArgs {
  /** The pledge UTXO to reclaim (as returned by `createPledge`). */
  utxo: PledgeUtxo;
  /** Fee to burn on the reclaim. */
  feeSats: number;
  /**
   * BEEF ancestry of the pledge's funding tx. Needed to hand the wallet an atomic
   * BEEF at internalisation — without it the wallet cannot validate the output it is
   * being asked to take custody of.
   */
  sourceBeef: number[];
}

export type WithdrawOutcome =
  | {
      ok: true;
      rawTx: string;
      txid: string;
      reclaimedSats: number;
      /** Everything `internalizePledgeRefund` needs once this tx is broadcast. */
      refund: { atomicBeef: number[]; outputIndex: number; derivationPrefix: string; derivationSuffix: string };
    }
  | { ok: false; reason: string };

/**
 * Reclaim a pledge — the contributor spending their own coin, which double-spends the
 * 0xC1 pledge and revokes it (ADR-025's refund).
 *
 * This exists because a pledge signature is a STANDING authorisation: ANYONECANPAY
 * binds only this input and the fixed output, so it never expires and nothing ties it
 * to the soft cap actually being met — anyone holding the signature can fund the
 * difference and push the sats to the project at any time. Spending the coin is the
 * contributor's ONLY revocation, so it has to be a real, reachable operation.
 *
 * The destination is derived HERE rather than supplied by the caller, and it is a
 * BRC-29 self-payment the wallet can take custody of. Paying to any other address the
 * contributor merely *owns* is not a refund in any sense they can use: the sats land
 * at a key their wallet never derives, so the balance does not move and the coin is
 * invisible until someone writes a bespoke script to find it. Reclaiming is only
 * finished once `internalizePledgeRefund` has run.
 *
 * Non-custodial throughout: the contributor's wallet derives the key and signs, no
 * operator key is involved, and the funds can go nowhere but back to that same wallet.
 */
export async function withdrawPledge(
  wallet: WalletInterface,
  chain: 'main' | 'test',
  args: WithdrawArgs,
): Promise<WithdrawOutcome> {
  let bsv: any;
  try {
    bsv = await loadBsv();
  } catch (e) {
    return { ok: false, reason: `load bsv: ${msg(e)}` };
  }

  const reclaimed = args.utxo.satoshis - args.feeSats;
  if (reclaimed <= 0) {
    return { ok: false, reason: `fee ${args.feeSats} leaves nothing of a ${args.utxo.satoshis}-sat pledge` };
  }

  try {
    // A fresh BRC-29 destination the wallet can internalise as an ordinary payment.
    const derivationPrefix = await createNonce(wallet, 'self', ORIGINATOR);
    const derivationSuffix = await createNonce(wallet, 'self', ORIGINATOR);
    const { publicKey: refundPub } = await wallet.getPublicKey(
      {
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: 'anyone',
        forSelf: true,
      } as any,
      ORIGINATOR,
    );
    const refundAddress = PublicKey.fromString(refundPub).toAddress(chain === 'main' ? 'mainnet' : 'testnet');
    const refundScriptHex = new P2PKH().lock(refundAddress).toHex();

    const tx = new bsv.Transaction();
    tx.from({
      txId: args.utxo.txid,
      outputIndex: args.utxo.vout,
      script: args.utxo.scriptHex,
      satoshis: args.utxo.satoshis,
    });
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(refundScriptHex), satoshis: reclaimed }));
    tx.inputs[0].output = new bsv.Transaction.Output({
      script: bsv.Script.fromHex(args.utxo.scriptHex),
      satoshis: args.utxo.satoshis,
    });

    const unlock = await signP2pkhInput({
      wallet,
      bsv,
      tx,
      inputIndex: 0,
      derivationPrefix: args.utxo.derivationPrefix,
      derivationSuffix: args.utxo.derivationSuffix,
      sourceScriptHex: args.utxo.scriptHex,
      sourceSatoshis: args.utxo.satoshis,
      sighashType: SIGHASH_WITHDRAW,
      originator: ORIGINATOR,
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
      return { ok: false, reason: `refund BEEF assembly: ${msg(e)}` };
    }

    return {
      ok: true,
      rawTx,
      txid,
      reclaimedSats: reclaimed,
      refund: { atomicBeef, outputIndex: 0, derivationPrefix, derivationSuffix },
    };
  } catch (e) {
    return { ok: false, reason: `withdraw build: ${msg(e)}` };
  }
}

/**
 * Take custody of a broadcast refund so it becomes ordinary spendable balance.
 *
 * A wallet does not adopt an output just because it can derive the key: until it is
 * internalised it is not in any basket, not in the balance, and not selectable — money
 * at the owner's name that the owner has no way to see. Call this after broadcasting
 * `withdrawPledge`'s tx, or the reclaim only looks finished.
 */
export async function internalizePledgeRefund(
  wallet: WalletInterface,
  refund: { atomicBeef: number[]; outputIndex: number; derivationPrefix: string; derivationSuffix: string },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res: any = await wallet.internalizeAction(
      {
        tx: refund.atomicBeef,
        description: 'presale pledge refund',
        labels: ['launchpad', 'presale-refund'],
        outputs: [
          {
            outputIndex: refund.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              // BRC-29 with counterparty 'anyone' — the well-known key, matching
              // how the destination above was derived.
              senderIdentityKey: new PrivateKey(1).toPublicKey().toString(),
              derivationPrefix: refund.derivationPrefix,
              derivationSuffix: refund.derivationSuffix,
            },
          },
        ],
      } as any,
      ORIGINATOR,
    );
    if (res?.accepted === false) return { ok: false, reason: 'the wallet declined the refund' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `internalize refund: ${msg(e)}` };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
