/// <reference path="./vendor.d.ts" />
/**
 * ledgerTx.ts — CLIENT-side assembly of ledger-pool buy/sell txs (ADR-027). The
 * pool-input unlock is built SERVER-side (scrypt-ts, via ledger-service); here we
 * only spend the pool UTXO with that unlock and add the wallet-funded input. Non-
 * custodial: the wallet funds the payment/fee input; the pool needs no key.
 *
 *   BUY  [pool (0xc3 SINGLE, server unlock), payment (wallet 0x41)] -> [successor@newReserve]
 *   SELL [pool (0xc1 ALL,    server unlock), fee     (wallet 0x41)] -> [successor@reserveAfter, payout@refund]
 *
 * No change output: the wallet input is sized so its whole surplus is the miner fee
 * (a change output would break the pool unlock's hashOutputs commitment).
 */
import type { WalletInterface } from '@bsv/sdk';
import { Transaction } from '@bsv/sdk';
import { signP2pkhInput } from '@launchpad/bsv/settle/p2pkh';
import { createTokenFundingOutput } from '@launchpad/bsv/settle/funding';
import { validateAssembledCovenantInput } from './covenant';

const SIGHASH_FUND = 0x41; // ALL | FORKID on the wallet input
const ORIGINATOR = 'launchpad.curve.ledger';

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

export interface LedgerPoolUtxo {
  txid: string;
  vout: number;
  scriptHex: string;
  reserveBefore: number;
}

export interface LedgerTxResult {
  ok: boolean;
  rawTx?: string;
  txid?: string;
  paymentTxid?: string;
  paymentRawTx?: string;
  newPool?: { txid: string; vout: number; scriptHex: string; reserveSats: number; sold: number };
  reason?: string;
}

/** BUY: spend the pool with the server unlock + a wallet payment input. */
export async function buildLedgerBuyTx(args: {
  wallet: WalletInterface; chain: 'main' | 'test';
  pool: LedgerPoolUtxo; unlockingHex: string; nextLockingHex: string;
  newReserve: number; cost: number; sold: number; delta: number;
  feeSats?: number; originator?: string;
}): Promise<LedgerTxResult> {
  const { wallet, chain, pool, unlockingHex, nextLockingHex, newReserve, cost, feeSats = 200, originator = ORIGINATOR } = args;
  try {
    const funding = await createTokenFundingOutput({ wallet, chain, satoshis: cost + feeSats, originator, description: 'curve ledger buy payment' });
    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    tx.addInput(new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }), bsv.Script.fromHex(pool.scriptHex), pool.reserveBefore);
    tx.addInput(new bsv.Transaction.Input({ prevTxId: funding.txid, outputIndex: funding.vout, script: new bsv.Script() }), bsv.Script.fromHex(funding.scriptHex), funding.satoshis);
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextLockingHex), satoshis: newReserve }));

    tx.inputs[0].setScript(bsv.Script.fromHex(unlockingHex));
    const fundUnlock = await signP2pkhInput({ wallet, bsv, tx, inputIndex: 1, derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix, sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_FUND, originator });
    tx.inputs[1].setScript(bsv.Script.fromHex(fundUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: pool.scriptHex, satoshis: pool.reserveBefore }, 0);
    if (!check.ok) return { ok: false, reason: `pool input failed interpreter check: ${check.error}` };

    let paymentRawTx = '';
    try { if (funding.beef?.length) paymentRawTx = Transaction.fromAtomicBEEF(funding.beef).toHex(); } catch { paymentRawTx = ''; }

    return { ok: true, rawTx, txid, paymentTxid: funding.txid, paymentRawTx, newPool: { txid, vout: 0, scriptHex: nextLockingHex, reserveSats: newReserve, sold: args.sold + args.delta } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** SELL: spend the pool with the server unlock + a wallet fee input; pay the seller. */
export async function buildLedgerSellTx(args: {
  wallet: WalletInterface; chain: 'main' | 'test';
  pool: LedgerPoolUtxo; unlockingHex: string; nextLockingHex: string; payoutScriptHex: string;
  reserveAfter: number; refund: number; sold: number; amount: number;
  feeSats?: number; originator?: string;
}): Promise<LedgerTxResult> {
  const { wallet, chain, pool, unlockingHex, nextLockingHex, payoutScriptHex, reserveAfter, refund, feeSats = 250, originator = ORIGINATOR } = args;
  try {
    const funding = await createTokenFundingOutput({ wallet, chain, satoshis: feeSats, originator, description: 'curve ledger sell fee' });
    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    tx.addInput(new bsv.Transaction.Input({ prevTxId: pool.txid, outputIndex: pool.vout, script: new bsv.Script() }), bsv.Script.fromHex(pool.scriptHex), pool.reserveBefore);
    tx.addInput(new bsv.Transaction.Input({ prevTxId: funding.txid, outputIndex: funding.vout, script: new bsv.Script() }), bsv.Script.fromHex(funding.scriptHex), funding.satoshis);
    // output order MUST match the server's unlock preimage (0xc1 pins both outputs)
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(nextLockingHex), satoshis: reserveAfter }));
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(payoutScriptHex), satoshis: refund }));

    tx.inputs[0].setScript(bsv.Script.fromHex(unlockingHex));
    const fundUnlock = await signP2pkhInput({ wallet, bsv, tx, inputIndex: 1, derivationPrefix: funding.derivationPrefix, derivationSuffix: funding.derivationSuffix, sourceScriptHex: funding.scriptHex, sourceSatoshis: funding.satoshis, sighashType: SIGHASH_FUND, originator });
    tx.inputs[1].setScript(bsv.Script.fromHex(fundUnlock));

    const rawTx: string = tx.toString();
    const txid = Transaction.fromHex(rawTx).id('hex');
    const check = validateAssembledCovenantInput(rawTx, { scriptHex: pool.scriptHex, satoshis: pool.reserveBefore }, 0);
    if (!check.ok) return { ok: false, reason: `pool input failed interpreter check: ${check.error}` };

    let paymentRawTx = '';
    try { if (funding.beef?.length) paymentRawTx = Transaction.fromAtomicBEEF(funding.beef).toHex(); } catch { paymentRawTx = ''; }

    return { ok: true, rawTx, txid, paymentTxid: funding.txid, paymentRawTx, newPool: { txid, vout: 0, scriptHex: nextLockingHex, reserveSats: reserveAfter, sold: args.sold - args.amount } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
