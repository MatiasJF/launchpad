import type { WalletInterface } from '@bsv/sdk';

/**
 * buildChainedAtomicBeef — SPV ancestry BEEF for the token input.
 *
 * First-pass: the token was internalized into the 'stas-tokens' basket at
 * issuance, so we ask the wallet for that basket's outputs *with their entire
 * transactions* — the returned BEEF carries the token tx + ancestry.
 *
 * NEEDS LIVE-WALLET VERIFICATION: the exact BEEF field name/shape from
 * listOutputs may vary; run a transfer and iterate on the real result (same
 * loop that got issuance working). See stas-knowledge-mcp `beef-assembly`.
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
