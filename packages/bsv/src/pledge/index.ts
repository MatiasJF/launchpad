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
import { Beef } from '@bsv/sdk';
import { createTokenFundingOutput } from '../settle/twoTx/fundingOutput';
import { BRC29_PROTOCOL_ID } from '../settle/twoTx/p2pkhInput';

export * from './assemble';

const ORIGINATOR = 'launchpad.pledge';
/** ANYONECANPAY (0x80) | ALL (0x01) | FORKID (0x40). Never 0x81 (no-FORKID) on BSV. */
const SIGHASH_ASSURANCE = 0xc1;

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

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
