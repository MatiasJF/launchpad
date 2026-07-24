/**
 * broadcastAndInternalizeChange — post TX2 and internalize the sender's BSV
 * change as a `wallet payment`. Ported from stas-knowledge-mcp. The token
 * recipient output rides on-chain in the same tx and is delivered to the peer
 * via the returned BEEF.
 */
import type { WalletInterface, InternalizeActionArgs } from '@bsv/sdk';
import { PrivateKey } from '@bsv/sdk';

export async function broadcastAndInternalizeChange(args: {
  wallet: WalletInterface;
  atomicBeef: number[];
  changeVout: number;
  derivationPrefix: string;
  derivationSuffix: string;
  originator: string;
  description?: string;
  labels?: string[];
}): Promise<{ accepted: boolean }> {
  const { wallet, atomicBeef, changeVout, derivationPrefix, derivationSuffix, originator } = args;

  const iargs: InternalizeActionArgs = {
    tx: atomicBeef,
    description: args.description ?? 'token transfer change',
    labels: args.labels ?? ['token', 'change'],
    outputs: [
      {
        outputIndex: changeVout,
        protocol: 'wallet payment',
        paymentRemittance: {
          senderIdentityKey: new PrivateKey(1).toPublicKey().toString(),
          derivationPrefix,
          derivationSuffix,
        },
      },
    ],
  };

  const res: any = await wallet.internalizeAction(iargs as any, originator);
  return { accepted: !!res?.accepted };
}
