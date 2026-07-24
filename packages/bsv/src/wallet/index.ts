/**
 * BRC-100 wallet connection (BSV Desktop). Stub — implemented in P1 (BSV-001).
 * Non-custodial: the app requests signatures; the user's wallet holds the keys.
 */
import { NOT_IMPLEMENTED } from '../notImplemented';

export interface WalletIdentity {
  identityPubkey: string;
  paymail?: string;
}

export async function connectWallet(): Promise<WalletIdentity> {
  return NOT_IMPLEMENTED('connectWallet (P1 / BSV-001)');
}
