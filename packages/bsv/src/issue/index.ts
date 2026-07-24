/** STAS issuance. Stub — implemented in P2 (BSV-002). */
import { NOT_IMPLEMENTED } from '../notImplemented';

export interface IssueTokenInput {
  name: string;
  ticker: string;
  decimals: number;
  totalSupply: bigint;
  /** Amount of the total supply to split into sale-pool UTXOs. */
  publicAllocation: bigint;
}

export interface IssueTokenResult {
  stasTokenId: string;
  issuanceTxid: string;
}

export async function issueStasToken(_input: IssueTokenInput): Promise<IssueTokenResult> {
  return NOT_IMPLEMENTED('issueStasToken (P2 / BSV-002)');
}
