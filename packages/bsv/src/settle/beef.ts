import type { WalletInterface } from '@bsv/sdk';

/**
 * buildChainedAtomicBeef — SPV ancestry BEEF for the token input, from the
 * wallet's 'stas-tokens' basket.
 *
 * NOTE (2026-07-27): this is now the FALLBACK path. It only works when the
 * source UTXO is tracked in the basket — true for a fresh mint, but NOT for a
 * token-change UTXO from a prior transfer (the settle flow never re-baskets the
 * token change, only the BSV change). Spending such a UTXO with this BEEF omits
 * the source tx and internalizeAction rejects it as "not valid AtomicBEEF".
 *
 * The PRIMARY path is now `StasSource.beef` — an ancestry BEEF fetched
 * from-chain (WoC `/tx/{txid}/beef`, incl. merkle proof) by
 * `apps/web/lib/settle-actions.ts:getSourceBeef`. That is storage-agnostic and
 * works for any confirmed pool UTXO. This basket path remains for the mint-based
 * BSV-003 test harness (SettleButton) and as a fallback.
 */
export async function buildChainedAtomicBeef(args: {
  wallet: WalletInterface;
  txid: string;
}): Promise<{ beef: number[]; atomicBeef: number[] }> {
  const w = args.wallet as unknown as {
    listOutputs: (a: unknown, o?: string) => Promise<{ BEEF?: number[]; outputs?: unknown[] }>;
  };

  const res = await w.listOutputs(
    { basket: 'stas-tokens', include: 'entire transactions', limit: 1000 },
    'launchpad.settle',
  );

  const beef = res?.BEEF;
  if (!Array.isArray(beef) || beef.length === 0) {
    throw new Error(
      `wallet returned no BEEF for the stas-tokens basket (token ${args.txid.slice(0, 12)}…). ` +
        'The token may not be tracked in the basket, or listOutputs BEEF has a different shape — needs live verification.',
    );
  }
  return { beef, atomicBeef: beef };
}
