/**
 * createTokenFundingOutput — TX1 of the two-tx STAS transfer. Ported from
 * stas-knowledge-mcp. A normal BSV createAction that produces one dedicated
 * P2PKH output at a self-owned BRC-29 address we derive, sized to cover TX2's
 * fee. Change fragmentation on TX1 is harmless (plain P2PKH). Returns the
 * outpoint + derivation + TX1's own BEEF for chaining into TX2.
 */
import type { WalletInterface } from '@bsv/sdk';
import { PublicKey, P2PKH, createNonce, Transaction, Beef } from '@bsv/sdk';
import { BRC29_PROTOCOL_ID } from './p2pkhInput';

export interface TokenFundingOutput {
  txid: string;
  vout: number;
  satoshis: number;
  scriptHex: string;
  derivationPrefix: string;
  derivationSuffix: string;
  beef: number[];
}

export async function createTokenFundingOutput(args: {
  wallet: WalletInterface;
  chain: 'main' | 'test';
  satoshis: number;
  originator: string;
  description?: string;
  /**
   * Optional wallet basket for the produced output. Pass a DEDICATED name (never
   * `default`) when the output must stay visible to — and spendable by — the owner's
   * wallet after this call: a basketless output is recorded `basketId: undefined,
   * change: false`, which `listOutputs` cannot enumerate (it filters on basketId and
   * requires a basket) and the wallet will never select. That is fine for a funding
   * output consumed moments later by TX2, and WRONG for a pledge the contributor must
   * be able to reclaim on their own (ADR-025). `default` is refused because the wallet
   * draws change from it, so it could silently spend a pledge and void its signature.
   */
  basket?: string;
  labels?: string[];
}): Promise<TokenFundingOutput> {
  const { wallet, chain, satoshis, originator } = args;
  if (args.basket === 'default') {
    throw new Error("refusing basket 'default': the wallet spends it as change and would void the pledge signature");
  }

  const derivationPrefix = await createNonce(wallet, 'self', originator);
  const derivationSuffix = await createNonce(wallet, 'self', originator);

  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: 'anyone',
      forSelf: true,
    } as any,
    originator,
  );
  const address = PublicKey.fromString(publicKey).toAddress(chain === 'main' ? 'mainnet' : 'testnet');
  const scriptHex = new P2PKH().lock(address).toHex();

  const res: any = await wallet.createAction(
    {
      description: args.description ?? 'token transfer funding',
      outputs: [
        {
          lockingScript: scriptHex,
          satoshis,
          outputDescription: 'token tx funding',
          customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, forSelf: true }),
          ...(args.basket ? { basket: args.basket } : {}),
        },
      ],
      ...(args.labels ? { labels: args.labels } : {}),
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    } as any,
    originator,
  );

  const txid: string = res.txid;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new Error(`funding createAction returned no txid (got ${JSON.stringify(res?.txid)})`);
  }
  const beef: number[] = Array.isArray(res.tx) ? res.tx : [];

  // Locate our output in the tx the wallet actually built rather than assuming vout 0
  // at the requested value. Callers spend this outpoint and sign a BIP-143 preimage
  // over its amount, so a wrong index or value produces an invalid signature, not
  // merely a wrong fee — worth one parse to turn an assumption into a check.
  const vout = findFundingVout(res, txid, scriptHex, satoshis);

  return { txid, vout, satoshis, scriptHex, derivationPrefix, derivationSuffix, beef };
}

function findFundingVout(res: any, txid: string, scriptHex: string, satoshis: number): number {
  let tx: any = null;
  try {
    tx = Transaction.fromAtomicBEEF(res.tx);
  } catch {
    try {
      tx = Beef.fromBinary(res.tx).findTxid(txid)?.tx ?? null;
    } catch {
      tx = null;
    }
  }
  if (!tx?.outputs) return 0; // wallet gave us no tx to check — preserve prior behaviour
  const want = scriptHex.toLowerCase();
  const idx = tx.outputs.findIndex(
    (o: any) => o.lockingScript?.toHex?.().toLowerCase() === want && Number(o.satoshis) === satoshis,
  );
  if (idx < 0) {
    const got = tx.outputs.map((o: any, i: number) => `${i}:${o.satoshis}`).join(' ');
    throw new Error(`funding output ${satoshis} sats not present in ${txid} (outputs ${got})`);
  }
  return idx;
}
