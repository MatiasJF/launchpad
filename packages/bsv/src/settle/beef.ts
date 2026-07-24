import type { WalletInterface } from '@bsv/sdk';

/**
 * buildChainedAtomicBeef — walk the token tx's ancestry into a BEEF whose every
 * leaf input carries a merkle proof (so unconfirmed/mempool parents are
 * included). See stas-knowledge-mcp `beef-assembly`.
 *
 * NOT IMPLEMENTED: this is the one piece the knowledge base leaves as
 * "you provide". It needs the wallet's ancestry/BEEF APIs (or WhatsOnChain) to
 * fetch each ancestor tx + proof. Implement + verify against a live wallet
 * holding an issued STAS UTXO before enabling settlement.
 */
export async function buildChainedAtomicBeef(_args: {
  wallet: WalletInterface;
  txid: string;
}): Promise<{ beef: number[]; atomicBeef: number[] }> {
  throw new Error(
    'buildChainedAtomicBeef not implemented — SPV ancestry assembly for the token input ' +
      'needs the wallet BEEF APIs (see stas-knowledge-mcp beef-assembly). Required before settlement can run.',
  );
}
