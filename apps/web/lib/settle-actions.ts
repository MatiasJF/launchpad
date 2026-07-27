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
