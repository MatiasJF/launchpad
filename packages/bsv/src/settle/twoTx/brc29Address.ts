/**
 * deriveSelfBrc29P2pkh — derive a self-owned BRC-29 P2PKH address/script.
 * Ported from stas-knowledge-mcp. Shared by TX1's funding output and TX2's
 * single change output (owned by our own key so we can sign + re-internalize it).
 */
import type { WalletInterface } from '@bsv/sdk';
import { PublicKey, P2PKH, createNonce } from '@bsv/sdk';
import { BRC29_PROTOCOL_ID } from './p2pkhInput';

export interface SelfBrc29Output {
  scriptHex: string;
  pkhHex: string;
  derivationPrefix: string;
  derivationSuffix: string;
}

export async function deriveSelfBrc29P2pkh(args: {
  wallet: WalletInterface;
  chain: 'main' | 'test';
  originator: string;
  derivationPrefix?: string;
  derivationSuffix?: string;
}): Promise<SelfBrc29Output> {
  const { wallet, chain, originator } = args;
  const derivationPrefix = args.derivationPrefix ?? (await createNonce(wallet, 'self', originator));
  const derivationSuffix = args.derivationSuffix ?? (await createNonce(wallet, 'self', originator));

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
  const pkhHex = scriptHex.substring(6, 46);

  return { scriptHex, pkhHex, derivationPrefix, derivationSuffix };
}
