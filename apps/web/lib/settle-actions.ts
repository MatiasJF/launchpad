'use server';

/**
 * Fetch a confirmed output's locking-script hex from WhatsOnChain (server-side,
 * no CORS). Used to reconstruct a STAS `source` UTXO for settlement.
 */
export async function getOutputScriptHex(txid: string, vout: number): Promise<string | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/out/${vout}/hex`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const hex = (await res.text()).trim();
    return /^[0-9a-fA-F]+$/.test(hex) ? hex : null;
  } catch {
    return null;
  }
}

/** Fetch a confirmed output's script hex + satoshi value (the STAS token balance). */
export async function getOutputInfo(
  txid: string,
  vout: number,
): Promise<{ scriptHex: string; satoshis: number } | null> {
  const scriptHex = await getOutputScriptHex(txid, vout);
  if (!scriptHex) return null;
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const tx = (await res.json()) as { vout?: { value?: number }[] };
    const value = tx.vout?.[vout]?.value;
    if (typeof value !== 'number') return null;
    return { scriptHex, satoshis: Math.round(value * 1e8) };
  } catch {
    return null;
  }
}

/**
 * Is a given output still unspent? WhatsOnChain's `/tx/{txid}/{vout}/spent`
 * returns 404 when the outpoint is unspent and a JSON body naming the spending
 * tx when it's already spent. We MUST check this before settling: the pool UTXO
 * moves after every partial send, and `getOutputInfo` (script + balance) will
 * happily return data for a spent output — the miner only rejects at broadcast
 * with a cryptic "Missing inputs". This turns that into a clear, early error.
 * Returns `{ unspent: true }`, `{ unspent: false, spentBy }`, or `{ unspent: null }`
 * (couldn't determine — treat as non-fatal, let broadcast be the backstop).
 */
export async function isOutputUnspent(
  txid: string,
  vout: number,
): Promise<{ unspent: boolean | null; spentBy?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
    return { unspent: null };
  }
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`, {
      cache: 'no-store',
    });
    if (res.status === 404) return { unspent: true };
    if (!res.ok) return { unspent: null };
    const body = (await res.text()).trim();
    let spentBy: string | undefined;
    try {
      spentBy = (JSON.parse(body) as { txid?: string }).txid;
    } catch {
      /* non-JSON body — leave spentBy undefined */
    }
    return { unspent: false, spentBy };
  } catch {
    return { unspent: null };
  }
}

/**
 * Verify on-chain that a payment tx actually pays a given address at least
 * `minSats`. Sums all outputs to `address` in the tx (WoC exposes standard-script
 * addresses on each vout). Retries briefly so a just-broadcast payment has time
 * to propagate to WoC's node. This is what makes a "buy" real — the order only
 * becomes settle-eligible once the seller's payout is confirmed on-chain.
 */
export async function verifyPaymentToAddress(
  txid: string,
  address: string,
  minSats: number,
): Promise<{ ok: boolean; paidSats?: number; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return { ok: false, error: 'invalid payment txid' };
  if (!address) return { ok: false, error: 'no payout address to verify against' };

  const attempts = 6; // ~ up to ~15s to allow mempool propagation
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`, { cache: 'no-store' });
      if (res.ok) {
        const tx = (await res.json()) as { vout?: { value?: number; scriptPubKey?: { addresses?: string[] } }[] };
        let paid = 0;
        for (const o of tx.vout ?? []) {
          if ((o.scriptPubKey?.addresses ?? []).includes(address) && typeof o.value === 'number') {
            paid += Math.round(o.value * 1e8);
          }
        }
        if (paid >= minSats) return { ok: true, paidSats: paid };
        // Tx found but underpays — this won't improve on retry; fail fast.
        return { ok: false, paidSats: paid, error: `paid ${paid} sats to ${address}, need ${minSats}` };
      }
      // Not indexed yet (likely 404) — wait and retry.
    } catch {
      /* transient — retry */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { ok: false, error: 'payment tx not found on-chain yet — it may still be propagating; try confirming again' };
}

/**
 * Resolve the CURRENT pool UTXO for a token by walking its change chain on-chain.
 *
 * The pool moves after every partial send: each settle spends the pool STAS
 * output and returns a smaller token-change output back to the same owner pkh.
 * Starting from the mint (`mintTxid:0`), we follow that chain of "change back to
 * owner" outputs until we hit one that is still unspent — that's the live pool.
 *
 * This kills the recurring "stale default txid" trap: the operator no longer
 * hand-tracks the moving UTXO. Owner pkh is derived from the mint's STAS script
 * (`76a914<pkh>88ac69…`); the change output at each hop is the one whose script
 * carries that same owner pkh + STAS marker (the recipient/BSV-change outputs
 * carry different pkhs).
 */
export async function resolveCurrentPool(
  mintTxid: string,
): Promise<{ txid: string; vout: number } | { error: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(mintTxid)) return { error: 'invalid mint txid' };
  const mintScript = await getOutputScriptHex(mintTxid, 0);
  if (!mintScript) return { error: 'could not fetch mint output script' };
  const ownerPkh = mintScript.substring(6, 46).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(ownerPkh)) return { error: 'could not derive owner pkh from mint' };
  const stasPrefix = `76a914${ownerPkh}88ac69`; // STAS token output locked to owner

  let txid = mintTxid;
  let vout = 0;
  for (let hop = 0; hop < 100; hop++) {
    const spent = await isOutputUnspent(txid, vout);
    if (spent.unspent === true) return { txid, vout };
    if (spent.unspent === null) return { error: `could not check spent status of ${txid.slice(0, 10)}…:${vout}` };
    const spendingTxid = spent.spentBy;
    if (!spendingTxid) return { error: `${txid.slice(0, 10)}…:${vout} is spent but the spender is unknown` };
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${spendingTxid}`, { cache: 'no-store' });
      if (!res.ok) return { error: `could not fetch spending tx ${spendingTxid.slice(0, 10)}…` };
      const tx = (await res.json()) as { vout?: { n: number; scriptPubKey?: { hex?: string } }[] };
      const change = tx.vout?.find((o) => (o.scriptPubKey?.hex ?? '').toLowerCase().startsWith(stasPrefix));
      if (!change) return { error: `no token change back to owner in ${spendingTxid.slice(0, 10)}… — chain ends (pool may be fully sold)` };
      txid = spendingTxid;
      vout = change.n;
    } catch {
      return { error: `network error walking the pool chain at ${spendingTxid.slice(0, 10)}…` };
    }
  }
  return { error: 'pool chain too long (100+ hops) — enter the UTXO manually' };
}

/**
 * Broadcast a raw signed tx to the network via WhatsOnChain (server-side, no
 * CORS) and return the miner's verdict. This is the authoritative "did it land"
 * check — the wallet's internalizeAction does not reliably propagate. On success
 * WoC echoes the txid; on rejection it returns the exact policy/script error,
 * which we surface verbatim for diagnosis.
 */
export async function broadcastRawTx(
  txHex: string,
  expectedTxid?: string,
): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  if (typeof txHex !== 'string' || !/^[0-9a-fA-F]+$/.test(txHex) || txHex.length % 2 !== 0) {
    return { ok: false, error: 'invalid raw tx hex' };
  }
  try {
    const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: txHex }),
      cache: 'no-store',
    });
    const body = (await res.text()).trim();
    // Already-in-mempool / already-known is a success for our purposes: the node
    // has the tx. (WoC surfaces the node's policy string.)
    if (/already known|already in|txn-already|257/i.test(body)) {
      return { ok: true, txid: expectedTxid ?? '' };
    }
    if (!res.ok) return { ok: false, error: `WoC ${res.status}: ${body}` };
    // Success body is the txid, usually JSON-quoted.
    const txid = body.replace(/^"|"$/g, '');
    if (/^[0-9a-fA-F]{64}$/.test(txid)) return { ok: true, txid };
    return { ok: false, error: `unexpected broadcast response: ${body}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fetch the source tx's ancestry BEEF from WhatsOnChain (server-side, no CORS).
 * For a CONFIRMED tx this bundles a merkle proof (BUMP) — a self-sufficient SPV
 * anchor for the STAS token input. This is what makes settlement storage-agnostic:
 * we can spend ANY pool UTXO (mint output OR a prior transfer's token change),
 * not only outputs the wallet happens to track in its `stas-tokens` basket.
 * Returns the BEEF as a byte array, or null if unavailable (e.g. still in mempool).
 */
export async function getSourceBeef(txid: string): Promise<number[] | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return null;
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/beef`, { cache: 'no-store' });
    if (!res.ok) return null;
    const hex = (await res.text()).trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substring(i, i + 2), 16));
    return bytes;
  } catch {
    return null;
  }
}
