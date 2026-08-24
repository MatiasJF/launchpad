/**
 * download-beef.ts — Client-side BEEF download utility
 *
 * Converts a BEEF (Binary Efficient Encoding Format) byte array into a
 * downloadable .beef file. BEEF is BSV's SPV proof format — it contains a
 * transaction plus its merkle proof ancestry, making it independently verifiable.
 *
 * Usage:
 *   downloadBeef(beefBytes, 'my-purchase-proof.beef')
 *
 * The user can then verify this proof offline using BSV tools, proving their
 * transaction happened without trusting the platform.
 */

/**
 * Trigger a browser download of a BEEF byte array as a .beef file.
 *
 * @param beef - BEEF byte array (number[] or Uint8Array)
 * @param filename - Download filename (should end in .beef)
 */
export function downloadBeef(beef: number[] | Uint8Array, filename: string): void {
  // Convert number[] to Uint8Array if needed
  const bytes = beef instanceof Uint8Array ? beef : new Uint8Array(beef);

  // Create a Blob from the bytes
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });

  // Create a temporary download link
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;

  // Trigger download
  document.body.appendChild(link);
  link.click();

  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Fetch BEEF for a transaction from WhatsOnChain and trigger download.
 *
 * @param txid - Transaction ID
 * @param chain - 'main' or 'test'
 * @param filename - Download filename (optional, defaults to txid.beef)
 */
export async function downloadBeefFromWoc(
  txid: string,
  chain: 'main' | 'test' = 'main',
  filename?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const baseUrl = chain === 'main' ? 'https://api.whatsonchain.com/v1/bsv/main' : 'https://api.whatsonchain.com/v1/bsv/test';
    const url = `${baseUrl}/tx/${txid}/beef`;

    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        return { ok: false, error: 'Transaction not found or not yet confirmed (BEEF requires confirmation)' };
      }
      return { ok: false, error: `WhatsOnChain returned ${response.status}` };
    }

    // WoC returns BEEF as hex string
    const hexString = await response.text();
    const beefBytes = hexToBytes(hexString);

    const downloadFilename = filename || `${txid.slice(0, 8)}-proof.beef`;
    downloadBeef(beefBytes, downloadFilename);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Convert hex string to byte array.
 */
function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/, '').replace(/\s/g, '');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes;
}
