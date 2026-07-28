/**
 * STAS token receive-register (WEB-003 follow-up).
 *
 * After the operator settles an order, the buyer holds a STAS token output
 * on-chain (settlement TX2, vout 0) — but their wallet doesn't yet TRACK it, so
 * it won't render or be spendable. "Receiving" is one call: `internalizeAction`
 * with a **basket insertion**, which tells the wallet to track that output as its
 * own. Pattern from stas-knowledge-mcp (`receive-register`), adapted to the
 * launchpad: the buyer never holds the transfer BEEF (the operator built it), so
 * this is the DISCOVERY-SCAN path — the caller fetches the settlement tx's BEEF
 * from-chain (WoC `/tx/{txid}/beef`, incl. merkle proof) and passes it in.
 *
 * Non-custodial: runs in the buyer's own wallet; no keys handled here.
 *
 * Idempotency is basket-based (a `listOutputs` scan on the active store), never a
 * local side table — so re-registering an already-held token is a harmless no-op.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Beef } from '@bsv/sdk';

/** The wallet basket STAS token UTXOs are tracked in (matches settle/beef.ts). */
export const STAS_BASKET = 'stas-tokens';

export interface ReceiveStasArgs {
  /** Settlement txid (TX2) that delivered the tokens to the buyer. */
  txid: string;
  /** Recipient token output index — always 0 for our settlement engine. */
  vout: number;
  /**
   * The settlement tx's BEEF, fetched from-chain by the caller (WoC `/tx/{txid}/beef`).
   * A plain (non-atomic) BEEF is fine — we convert it to AtomicBEEF for `txid`
   * here, which is what `internalizeAction` requires.
   */
  atomicBeef: number[];
  /**
   * Token metadata + owner derivation, stamped so the output renders from
   * `listOutputs` alone and the spend path can re-derive the owner key. JSON
   * string, e.g. `{ protocolID, keyID, counterparty, tokenId, ticker }`.
   */
  customInstructions?: string;
  tags?: string[];
  originator?: string;
}

export interface ReceiveStasResult {
  registered: boolean;
  txid: string;
  vout: number;
  reason?: string;
}

export async function receiveStasToken(
  wallet: WalletInterface,
  args: ReceiveStasArgs,
): Promise<ReceiveStasResult> {
  const { txid, vout, atomicBeef } = args;
  const originator = args.originator ?? 'launchpad.receive';

  if (!Array.isArray(atomicBeef) || atomicBeef.length === 0) {
    return { registered: false, txid, vout, reason: 'no transfer BEEF to internalize (tx must be confirmed to fetch it)' };
  }

  // internalizeAction requires AtomicBEEF (BEEF with `txid` marked as the subject).
  // The from-chain BEEF is plain, so convert it here. toBinaryAtomic also validates
  // that `txid` and its SPV proof are actually present in the BEEF.
  let atomic: number[];
  try {
    atomic = Beef.fromBinary(atomicBeef).toBinaryAtomic(txid);
  } catch (err) {
    return {
      registered: false,
      txid,
      vout,
      reason: `could not build AtomicBEEF for ${txid.slice(0, 12)}…: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Idempotency — storage-agnostic basket read. If we already hold the outpoint,
  // registering again would conflict; report a benign no-op instead.
  try {
    const res = (await (wallet as unknown as {
      listOutputs: (a: unknown, o?: string) => Promise<{ outputs?: { outpoint?: string }[] }>;
    }).listOutputs({ basket: STAS_BASKET, limit: 1000 }, originator)) ?? {};
    for (const o of res.outputs ?? []) {
      if (o?.outpoint === `${txid}.${vout}`) return { registered: false, txid, vout, reason: 'already registered' };
    }
  } catch {
    /* best effort — on a read failure, let internalize run */
  }

  try {
    await wallet.internalizeAction(
      {
        tx: atomic,
        outputs: [
          {
            outputIndex: vout,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: STAS_BASKET,
              customInstructions: args.customInstructions,
              tags: args.tags ?? ['launchpad', 'stas'],
            },
          },
        ],
        description: 'STAS receive',
        seekPermission: false,
      } as never,
      originator,
    );
  } catch (err) {
    return {
      registered: false,
      txid,
      vout,
      reason: `internalizeAction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { registered: true, txid, vout };
}
