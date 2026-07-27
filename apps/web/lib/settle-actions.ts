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
