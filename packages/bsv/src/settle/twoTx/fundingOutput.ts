/**
 * createTokenFundingOutput — TX1 of the two-tx STAS transfer. Ported from
 * stas-knowledge-mcp. A normal BSV createAction that produces one dedicated
 * P2PKH output at a self-owned BRC-29 address we derive, sized to cover TX2's
 * fee. Change fragmentation on TX1 is harmless (plain P2PKH). Returns the
 * outpoint + derivation + TX1's own BEEF for chaining into TX2.
 */
import type { WalletInterface } from '@bsv/sdk';
import { PublicKey, P2PKH, createNonce } from '@bsv/sdk';
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
}): Promise<TokenFundingOutput> {
  const { wallet, chain, satoshis, originator } = args;

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
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    } as any,
    originator,
  );

  const txid: string = res.txid;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new Error(`funding createAction returned no txid (got ${JSON.stringify(res?.txid)})`);
  }
  const beef: number[] = Array.isArray(res.tx) ? res.tx : [];

  return { txid, vout: 0, satoshis, scriptHex, derivationPrefix, derivationSuffix, beef };
}
