/**
 * BRC-100 wallet connection (BSV Desktop). Uses @bsv/sdk WalletClient with the
 * 'auto' substrate — it probes window.CWI and the local wallet HTTP substrates.
 *
 * Non-custodial (golden rule 3): the user's wallet holds the keys. We only
 * request their identity, network, and balance — and, later, signatures.
 */
import { WalletClient } from '@bsv/sdk';

const ORIGINATOR = 'launchpad.local';

let client: WalletClient | null = null;
function getClient(): WalletClient {
  if (!client) client = new WalletClient('auto', ORIGINATOR);
  return client;
}

export interface WalletIdentity {
  identityPubkey: string;
  network: 'mainnet' | 'testnet';
}

/** Connect to the user's BRC-100 wallet and return their identity. */
export async function connectWallet(): Promise<WalletIdentity> {
  const wallet = getClient();
  await wallet.waitForAuthentication({});
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const { network } = await wallet.getNetwork({});
  return { identityPubkey: publicKey, network };
}

/** Spendable balance (sats), summed from the wallet's default basket. */
export async function getBalanceSats(): Promise<number> {
  const wallet = getClient();
  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 });
  return outputs.reduce((sum, o) => sum + o.satoshis, 0);
}

/** Human-friendly message for a wallet error. */
export function walletError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('No wallet available')) {
    return 'No BSV wallet found. Open BSV Desktop (or another BRC-100 wallet) and try again.';
  }
  return msg;
}
