/// <reference path="../vendor.d.ts" />

/**
 * Assemble + sign the assurance transaction from collected pledges (ADR-025).
 *
 * When enough still-unspent pledges sum to the soft cap, the project (the payout
 * beneficiary) builds ONE transaction: every pledge input (each already signed
 * 0xC1 by its contributor) + one project-owned fee input → a single fixed output
 * of exactly `softCap` sats to the project. The output set MUST equal what the
 * pledges signed over ([softCap → project]) — so there is NO change output; the
 * fee is a project-supplied input sized to the fee and fully consumed. The
 * project signs only its own fee input (0x41). Broadcasting this delivers the
 * raised sats to the project trustlessly (contributor funds moved only now, only
 * because the cap was met). NO broadcast here — the caller broadcasts.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Transaction } from '@bsv/sdk';
import { createTokenFundingOutput } from '../settle/twoTx/fundingOutput';
import { signP2pkhInput } from '../settle/twoTx/p2pkhInput';

const ORIGINATOR = 'launchpad.assemble';
const SIGHASH_FEE = 0x41; // ALL | FORKID for the project's fee input

export interface PledgeInput {
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  sigHex: string; // 0xC1 signature the contributor produced
  pubkeyHex: string;
}

export interface AssembleArgs {
  pledges: PledgeInput[];
  /** Fixed assurance output value = the soft cap (sum of the included pledges). */
  softCapSats: number;
  /** Fixed assurance output recipient — the project payout address. */
  projectAddress: string;
}

export type AssembleOutcome =
  | { ok: true; assuranceRawTx: string; assuranceTxid: string; feeFundingRawTx: string; feeSats: number }
  | { ok: false; reason: string };

async function loadBsv(): Promise<any> {
  const m: any = await import('bsv');
  return m.default ?? m;
}

export async function assembleAssuranceTx(
  wallet: WalletInterface,
  chain: 'main' | 'test',
  args: AssembleArgs,
): Promise<AssembleOutcome> {
  let bsv: any;
  try {
    bsv = await loadBsv();
  } catch (e) {
    return { ok: false, reason: `load bsv: ${msg(e)}` };
  }

  const pledgeSum = args.pledges.reduce((s, p) => s + p.satoshis, 0);
  if (pledgeSum !== args.softCapSats) {
    return { ok: false, reason: `included pledges sum ${pledgeSum} ≠ soft cap ${args.softCapSats} (must be exact)` };
  }

  // Fee: (N pledges + 1 fee input) P2PKH ins + 1 output. 0.05 sat/byte, floored.
  // Overhead is 44 B, not 40: 4 version + 1 inCount varint + 1 outCount varint +
  // 34 output + 4 nLockTime (measured). 148 B/input is the true worst case — real
  // inputs run 146-148 because ECDSA sigs are 71 or 72 bytes. There is NO change
  // output to absorb an error (every pledge signed SIGHASH_ALL over the output set),
  // so the estimate must never come in under the truth.
  const estSize = (args.pledges.length + 1) * 148 + 44;
  const feeSats = Math.max(40, Math.ceil(estSize * 0.05));

  // Project mints a fee-sized UTXO it owns (fully consumed as the tx fee — no
  // change output is possible without invalidating the pledge signatures).
  let fee;
  try {
    fee = await createTokenFundingOutput({ wallet, chain, satoshis: feeSats, originator: ORIGINATOR, description: 'assurance fee' });
  } catch (e) {
    return { ok: false, reason: `mint fee UTXO: ${msg(e)}` };
  }
  let feeFundingRawTx = '';
  try {
    const { Beef } = await import('@bsv/sdk');
    const b = Beef.fromBinary(fee.beef);
    const t = b.findTxid(fee.txid);
    feeFundingRawTx = t?.tx ? t.tx.toHex() : '';
  } catch {
    feeFundingRawTx = '';
  }
  if (!feeFundingRawTx) return { ok: false, reason: 'could not extract fee funding raw tx' };

  try {
    const recipientPkh = bsv.Address.fromString(args.projectAddress).hashBuffer.toString('hex');
    const outScript = bsv.Script.fromASM(`OP_DUP OP_HASH160 ${recipientPkh} OP_EQUALVERIFY OP_CHECKSIG`);
    const tx = new bsv.Transaction();

    // Pledge inputs (already signed 0xC1 by contributors).
    for (const p of args.pledges) {
      tx.from({ txId: p.txid, outputIndex: p.vout, script: p.scriptHex, satoshis: p.satoshis });
    }
    // Project fee input (signed below).
    tx.from({ txId: fee.txid, outputIndex: fee.vout, script: fee.scriptHex, satoshis: fee.satoshis });

    // The single fixed output — exactly what every pledge signed over.
    tx.addOutput(new bsv.Transaction.Output({ script: outScript, satoshis: args.softCapSats }));

    // Attach each pledge's unlocking script `<sig> <pubkey>`.
    args.pledges.forEach((p, i) => {
      tx.inputs[i].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(p.scriptHex), satoshis: p.satoshis });
      tx.inputs[i].setScript(bsv.Script.fromASM(`${p.sigHex} ${p.pubkeyHex}`));
    });

    // Sign the project's fee input (last input) with the wallet (0x41 P2PKH).
    const feeIdx = args.pledges.length;
    tx.inputs[feeIdx].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(fee.scriptHex), satoshis: fee.satoshis });
    const feeUnlock = await signP2pkhInput({
      wallet,
      bsv,
      tx,
      inputIndex: feeIdx,
      derivationPrefix: fee.derivationPrefix,
      derivationSuffix: fee.derivationSuffix,
      sourceScriptHex: fee.scriptHex,
      sourceSatoshis: fee.satoshis,
      sighashType: SIGHASH_FEE,
      originator: ORIGINATOR,
    });
    tx.inputs[feeIdx].setScript(bsv.Script.fromHex(feeUnlock));

    const assuranceRawTx = tx.toString();
    const assuranceTxid = Transaction.fromHex(assuranceRawTx).id('hex');
    return { ok: true, assuranceRawTx, assuranceTxid, feeFundingRawTx, feeSats };
  } catch (e) {
    return { ok: false, reason: `assurance assembly: ${msg(e)}` };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
