/** Settlement: build + broadcast (ARC). Stub — implemented in P3 (BSV-003). */
import { NOT_IMPLEMENTED } from '../notImplemented';

export interface SettleBuyInput {
  saleId: string;
  buyerIdentity: string;
  tokens: bigint;
  satsPaid: bigint;
}

export interface SettleResult {
  txid: string;
}

/** Deliver tokens for an instant buy and broadcast via ARC. */
export async function settleInstantBuy(_input: SettleBuyInput): Promise<SettleResult> {
  return NOT_IMPLEMENTED('settleInstantBuy (P3 / BSV-003)');
}

/** Return funds to a buyer — escrow refund / emergency withdraw (ADR-009). Future. */
export async function refund(_orderId: string): Promise<SettleResult> {
  return NOT_IMPLEMENTED('refund (future — escrow layer)');
}
