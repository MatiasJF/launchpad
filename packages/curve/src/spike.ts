/// <reference path="./vendor.d.ts" />
/**
 * spike.ts — the Phase-0 LIVE mainnet proof (ADR-026): deploy the Counter
 * covenant on-chain, then broadcast a self-replicating spend that increments it.
 *
 * Non-custodial throughout. The deploy is a plain wallet `createAction` (the
 * wallet funds + signs + broadcasts). The increment spend is hand-assembled: the
 * covenant input carries NO signature — it is satisfied purely by pushing this
 * tx's BIP-143 preimage (OP_PUSH_TX) — and a second, wallet-owned input pays the
 * miner fee (the covenant enforces successor.value == covenant.value, so the fee
 * cannot come from the covenant itself). This is exactly the shape the AMM
 * buy/sell flow will take, minus the curve math.
 */
import type { WalletInterface } from '@bsv/sdk';
import { PublicKey, P2PKH, createNonce, Transaction } from '@bsv/sdk';
import { signP2pkhInput, BRC29_PROTOCOL_ID } from '@launchpad/bsv/settle/p2pkh';
import locks from '../artifacts/locks.json';
import { validateAssembledCovenantInput } from './covenant';

type Chain = 'main' | 'test';

/** sighash the covenant checks: ANYONECANPAY | SINGLE | FORKID (0xc3). */
const SIGHASH_COVENANT = 0xc3;
/** the fee input signs ALL | FORKID (0x41), pinning the successor output. */
const SIGHASH_FEE = 0x41;
const ORIGINATOR = 'launchpad.curve.spike';

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

export interface CovenantUtxo {
  txid: string;
  vout: number;
  scriptHex: string;
  satoshis: number;
}
export interface FeeUtxo extends CovenantUtxo {
  derivationPrefix: string;
  derivationSuffix: string;
}

export interface DeployResult {
  txid: string;
  covenant: CovenantUtxo;
  fee: FeeUtxo;
}

/**
 * Deploy: one wallet tx creating (vout 0) the Counter covenant locked at count=0
 * and (vout 1) a self-owned P2PKH output that will pay the increment's fee.
 */
export async function deployCovenant(args: {
  wallet: WalletInterface;
  chain: Chain;
  covenantSats: number;
  feeSats: number;
  originator?: string;
}): Promise<DeployResult> {
  const { wallet, chain, covenantSats, feeSats, originator = ORIGINATOR } = args;

  const derivationPrefix = await createNonce(wallet, 'self', originator);
  const derivationSuffix = await createNonce(wallet, 'self', originator);
  const { publicKey } = await wallet.getPublicKey(
    { protocolID: BRC29_PROTOCOL_ID, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: 'anyone', forSelf: true } as never,
    originator,
  );
  const address = PublicKey.fromString(publicKey).toAddress(chain === 'main' ? 'mainnet' : 'testnet');
  const feeScriptHex = new P2PKH().lock(address).toHex();
  const covenantScriptHex = locks.ls0;

  const res: any = await wallet.createAction(
    {
      description: 'deploy counter covenant (count=0)',
      outputs: [
        { lockingScript: covenantScriptHex, satoshis: covenantSats, outputDescription: 'counter covenant count=0' },
        {
          lockingScript: feeScriptHex,
          satoshis: feeSats,
          outputDescription: 'increment fee funding',
          customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, forSelf: true }),
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    } as never,
    originator,
  );

  const txid: string = res.txid;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new Error(`deploy createAction returned no txid (got ${JSON.stringify(res?.txid)})`);
  }

  return {
    txid,
    covenant: { txid, vout: 0, scriptHex: covenantScriptHex, satoshis: covenantSats },
    fee: { txid, vout: 1, scriptHex: feeScriptHex, satoshis: feeSats, derivationPrefix, derivationSuffix },
  };
}

export interface IncrementResult {
  ok: boolean;
  rawTx?: string;
  txid?: string;
  /** True iff the covenant input validates in @bsv/sdk's interpreter pre-broadcast. */
  verifiedLocally?: boolean;
  reason?: string;
}

/**
 * Build (do not broadcast) the increment spend: covenant(count=0) -> covenant(count=1),
 * fee paid by the wallet-owned input. Returns rawTx + txid, and cross-checks the
 * covenant input against @bsv/sdk's interpreter before returning so a lib mismatch
 * is caught here rather than by a rejected broadcast.
 */
export async function buildIncrementTx(args: {
  wallet: WalletInterface;
  covenant: CovenantUtxo;
  fee: FeeUtxo;
  originator?: string;
}): Promise<IncrementResult> {
  const { wallet, covenant, fee, originator = ORIGINATOR } = args;
  const nextLockHex = locks.ls1; // successor: count = 1
  try {
    const bsv = await loadBsv();
    const tx = new bsv.Transaction();

    // input 0 — the covenant UTXO (unlocked by the preimage, no signature).
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: covenant.txid, outputIndex: covenant.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(covenant.scriptHex),
      covenant.satoshis,
    );
    // input 1 — the wallet-owned fee UTXO.
    tx.addInput(
      new bsv.Transaction.Input({ prevTxId: fee.txid, outputIndex: fee.vout, script: new bsv.Script() }),
      bsv.Script.fromHex(fee.scriptHex),
      fee.satoshis,
    );
    // output 0 — the successor covenant, value preserved (covenant enforces this).
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextLockHex), satoshis: covenant.satoshis }));
    // no change output: the entire fee UTXO becomes the miner fee (SINGLE pins only output 0).

    // Covenant input: push this tx's ANYONECANPAY|SINGLE|FORKID preimage.
    const covScript = bsv.Script.fromHex(covenant.scriptHex);
    const covSatsBN = new bsv.crypto.BN(covenant.satoshis);
    const preimageBuf: Buffer = bsv.Transaction.sighash.sighashPreimage(tx, SIGHASH_COVENANT, 0, covScript, covSatsBN);
    tx.inputs[0].setScript(new bsv.Script().add(preimageBuf));

    // Fee input: standard BRC-29 P2PKH signature (ALL|FORKID).
    const feeUnlock = await signP2pkhInput({
      wallet, bsv, tx, inputIndex: 1,
      derivationPrefix: fee.derivationPrefix, derivationSuffix: fee.derivationSuffix,
      sourceScriptHex: fee.scriptHex, sourceSatoshis: fee.satoshis, sighashType: SIGHASH_FEE, originator,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(feeUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');

    // Pre-broadcast guard: run the covenant input of the REAL assembled tx through
    // @bsv/sdk's interpreter. This reads the actual outpoint/version/outputs from
    // the tx, so it can't false-alarm on an idealized reference the way a preimage
    // comparison did — it genuinely answers "will the covenant accept this tx?".
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: covenant.scriptHex, satoshis: covenant.satoshis }, 0);

    return { ok: true, rawTx, txid, verifiedLocally: check.ok, reason: check.error };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
