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
 * Broadcast a raw signed tx to the network via WhatsOnChain (server-side, no
 * CORS) and return the miner's verdict. This is the authoritative "did it land"
 * check — the wallet's internalizeAction does not reliably propagate. On success
 * WoC echoes the txid; on rejection it returns the exact policy/script error,
 * which we surface verbatim for diagnosis.
 */
export async function broadcastRawTx(
  txHex: string,
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
