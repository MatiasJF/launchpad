/**
 * provenance.ts — FULL-provenance STAS back-to-genesis authenticity (ADR-028 step-3,
 * FIX 2). Pure + transport-agnostic: the caller injects the on-chain fetchers (WoC in
 * production, an in-memory graph in tests), so the money-critical algorithm is unit-
 * testable offline with no network.
 *
 * WHY "full provenance" and not "first genuine ancestor": an attacker can buy 1 genuine
 * token and fabricate a same-tail COUNTERFEIT output for the rest (mintable from a plain
 * P2PKH with no STAS parent — the ADR-025 asymmetry), then MERGE them into a δ-token
 * return. A walk that stops at the first genuine ancestor would pass and refund δ,
 * draining the reserve. So authenticity requires the WHOLE amount to descend from the
 * operator's own issuance:
 *   genuine(tx) ⇔ tx IS the issuance, OR
 *     (a) every same-tail STAS INPUT of tx is itself genuine, AND
 *     (b) tx has ≥1 same-tail STAS input (a same-tail output with none is a fabricated
 *         mint → counterfeit), AND
 *     (c) tx conserves same-tail tokens (Σ same-tail outputs ≤ Σ same-tail inputs — no
 *         injected/unbacked tokens).
 * The ancestry is a DAG (merges), so the walk is memoised by txid and BOUNDED by a node
 * budget; it is FAIL-CLOSED — any fetch gap, cycle, exceeded budget, tail mismatch, or
 * unbacked ancestry yields `authentic:false`.
 */

/** STAS token output shape: `76a914 <ownerPkh:20> 88ac69 <token tail…>`. */
export function isStasScript(hex: string): boolean {
  return typeof hex === 'string' && hex.length >= 52 && hex.toLowerCase().startsWith('76a914') && hex.substring(46, 52).toLowerCase() === '88ac69';
}
/** Owner pkh of a STAS output (hex). */
export function stasOwnerPkh(hex: string): string {
  return hex.substring(6, 46).toLowerCase();
}
/** The token "tail" after the owner pkh — the tokenId/issuer fingerprint, constant
 *  across every transfer of the same token (only the owner pkh changes). */
export function stasTail(hex: string): string {
  return hex.substring(52).toLowerCase();
}

export interface ProvenanceDeps {
  /** The operator's own genesis ISSUE txid (lowercased inside). */
  issuanceTxid: string;
  /** The genuine token tail (from the issuance STAS output). */
  genuineTail: string;
  /** Fetch an output's script hex + token sats, or null on failure. */
  getOutput: (txid: string, vout: number) => Promise<{ scriptHex: string; sats: number } | null>;
  /** Fetch a tx's inputs (prevout outpoints) + outputs (script + sats), or null. */
  getTxIO: (txid: string) => Promise<{ vin: { txid: string; vout: number }[]; vout: { n: number; hex: string; sats: number }[] } | null>;
  /** Max distinct txs to traverse before failing closed (default 400). */
  maxNodes?: number;
}

export type ProvenanceVerdict = { authentic: boolean; nodes?: number; reason?: string };

/**
 * Verify the STAS UTXO at `rootTxid:rootVout` is a genuine, fully-backed token of the
 * operator's own mint. Returns `{authentic:true}` only if every token in it provably
 * descends from `issuanceTxid`.
 */
export async function provenanceWalk(rootTxid: string, rootVout: number, deps: ProvenanceDeps): Promise<ProvenanceVerdict> {
  const issuance = deps.issuanceTxid.toLowerCase();
  const genuineTail = deps.genuineTail.toLowerCase();
  const MAX_NODES = deps.maxNodes ?? 400;

  // The returned output itself must be a well-formed same-tail STAS output.
  const rootOut = await deps.getOutput(rootTxid, rootVout);
  if (!rootOut) return { authentic: false, reason: 'could not read the returned output' };
  if (!isStasScript(rootOut.scriptHex)) return { authentic: false, reason: 'returned output is not a STAS script' };
  if (stasTail(rootOut.scriptHex) !== genuineTail) return { authentic: false, reason: 'token tail mismatch — counterfeit (different genesis)' };

  const memo = new Map<string, boolean>();
  const inProgress = new Set<string>();
  let budget = MAX_NODES;

  // true = fully-backed genuine; false = counterfeit/inflated; null = indeterminate (fail-closed).
  async function genuine(txidRaw: string): Promise<boolean | null> {
    const txid = txidRaw.toLowerCase();
    if (txid === issuance) return true; // genesis boundary (its parent is the non-STAS contract)
    const cached = memo.get(txid);
    if (cached !== undefined) return cached;
    if (inProgress.has(txid)) return null; // cycle → fail-closed
    if (--budget < 0) return null; // fabricated deep/wide provenance → fail-closed
    inProgress.add(txid);

    const io = await deps.getTxIO(txid);
    if (!io) { inProgress.delete(txid); return null; }

    let inputSats = 0;
    const parents: string[] = [];
    for (const vin of io.vin) {
      const prev = await deps.getOutput(vin.txid, vin.vout);
      if (!prev) { inProgress.delete(txid); return null; } // gap → fail-closed
      if (isStasScript(prev.scriptHex) && stasTail(prev.scriptHex) === genuineTail) {
        inputSats += prev.sats;
        parents.push(vin.txid);
      }
    }
    // A same-tail output with no same-tail STAS backing is a fabricated mint → counterfeit.
    if (parents.length === 0) { inProgress.delete(txid); memo.set(txid, false); return false; }

    // Conservation: this tx must not emit more same-tail tokens than it consumes.
    let outputSats = 0;
    for (const o of io.vout) if (isStasScript(o.hex) && stasTail(o.hex) === genuineTail) outputSats += o.sats;
    if (outputSats > inputSats) { inProgress.delete(txid); memo.set(txid, false); return false; } // injected tokens

    // EVERY same-tail parent must itself be genuine (no first-match shortcut).
    for (const p of parents) {
      const g = await genuine(p);
      if (g === null) { inProgress.delete(txid); return null; }
      if (!g) { inProgress.delete(txid); memo.set(txid, false); return false; }
    }
    inProgress.delete(txid);
    memo.set(txid, true);
    return true;
  }

  const g = await genuine(rootTxid);
  if (g === true) return { authentic: true, nodes: MAX_NODES - budget };
  if (g === null) return { authentic: false, reason: 'provenance unverifiable (fetch gap, cycle, or exceeded node budget) — fail-closed' };
  return { authentic: false, reason: 'ancestry not fully backed by genuine issuance (counterfeit or injected tokens)' };
}
