/**
 * poolAnnounce.ts — make a pool self-describing on-chain (ADR-030, discovery).
 *
 * THE LAST PLACE WE WERE LOAD-BEARING. Reading a pool needs its genesis outpoint AND its immutable
 * terms (k, supply, payoutPkh). The outpoint is on-chain, but the terms lived only in our database:
 * a client that had the txid still could not resolve the pool without asking us, and a holder whose
 * project vanished could not reconstruct what they were owed. That is a real dependency, and it
 * quietly undercut "anyone can build a UI over it".
 *
 * The fix is to publish the terms in an OP_RETURN in the deploy transaction, so the genesis
 * transaction alone carries everything needed to read the pool.
 *
 * WHY THE ANNOUNCEMENT NEED NOT BE TRUSTED. It is unsigned data that anyone can write, so on its
 * own it proves nothing — someone could publish a transaction claiming any terms they like. What
 * makes it safe is that the terms are CHECKABLE: rebuild the genesis locking script from the
 * announced (k, supply, payoutPkh) and require it to byte-match the covenant output actually sitting
 * at that outpoint. A lie cannot survive that, because the script commits to every one of those
 * values. So the announcement is a HINT that the chain itself verifies, never an authority.
 *
 * Enumeration (finding pools you were never told about) still needs an indexer or overlay, because
 * nothing lets you scan the chain for a prefix unaided. But the format below is public and
 * self-contained, so anyone can run that index — which is the difference between a convenience and
 * a dependency.
 */

/** Protocol marker. Bumped only for a breaking change to the field layout. */
export const ANNOUNCE_PREFIX = 'BSVLP';
export const ANNOUNCE_KIND = 'mlp1'; // merkle ledger pool, v1

export interface PoolAnnouncement {
  k: string;
  supply: string;
  payoutPkh: string;
  /** display only — never trusted, and never part of the covenant */
  ticker?: string;
}

const utf8 = (s: string): number[] => Array.from(Buffer.from(s, 'utf8'));
const hexBytes = (h: string): number[] => Array.from(Buffer.from(h, 'hex'));

/** Length-prefix one push exactly as Script does (all our fields are well under 76 bytes). */
function push(data: number[]): number[] {
  if (data.length < 0x4c) return [data.length, ...data];
  if (data.length <= 0xff) return [0x4c, data.length, ...data];
  throw new Error('poolAnnounce: field too long');
}

/**
 * The announcement output script: `OP_FALSE OP_RETURN <prefix> <kind> <k> <supply> <payoutPkh>
 * [<ticker>]`. OP_FALSE OP_RETURN makes it provably unspendable, so it costs nothing but its bytes
 * and can carry 0 satoshis.
 */
export function encodePoolAnnouncement(a: PoolAnnouncement): string {
  if (!/^[0-9a-fA-F]{40}$/.test(a.payoutPkh)) throw new Error('payoutPkh must be 20 bytes of hex');
  if (!/^\d+$/.test(a.k) || !/^\d+$/.test(a.supply)) throw new Error('k and supply must be decimal integers');
  const parts: number[] = [0x00, 0x6a]; // OP_FALSE OP_RETURN
  parts.push(...push(utf8(ANNOUNCE_PREFIX)));
  parts.push(...push(utf8(ANNOUNCE_KIND)));
  parts.push(...push(utf8(a.k)));
  parts.push(...push(utf8(a.supply)));
  parts.push(...push(hexBytes(a.payoutPkh)));
  if (a.ticker) parts.push(...push(utf8(a.ticker.slice(0, 32))));
  return Buffer.from(parts).toString('hex');
}

/**
 * Parse an announcement out of an output script. Returns null for anything that is not one — this
 * is called against every output of a candidate transaction, so being strict is the point.
 */
export function decodePoolAnnouncement(scriptHex: string): PoolAnnouncement | null {
  let buf: Buffer;
  try { buf = Buffer.from(scriptHex, 'hex'); } catch { return null; }
  if (buf.length < 4 || buf[0] !== 0x00 || buf[1] !== 0x6a) return null;

  // Every index is bounds-checked explicitly: this parses UNTRUSTED bytes from a stranger's
  // transaction, so a truncated or hostile push must yield null rather than a half-read field.
  const fields: Buffer[] = [];
  let i = 2;
  while (i < buf.length && fields.length < 8) {
    const op = buf[i];
    if (op === undefined) return null;
    let len: number;
    if (op < 0x4c) { len = op; i += 1; }
    else if (op === 0x4c) {
      const n = buf[i + 1];
      if (n === undefined) return null;
      len = n; i += 2;
    } else return null; // we never emit larger pushes
    if (i + len > buf.length) return null;
    fields.push(buf.subarray(i, i + len));
    i += len;
  }
  if (fields.length < 5) return null;
  const [f0, f1, f2, f3, f4, f5] = fields;
  if (!f0 || !f1 || !f2 || !f3 || !f4) return null;
  if (f0.toString('utf8') !== ANNOUNCE_PREFIX) return null;
  if (f1.toString('utf8') !== ANNOUNCE_KIND) return null;

  const k = f2.toString('utf8');
  const supply = f3.toString('utf8');
  const payoutPkh = f4.toString('hex');
  if (!/^\d+$/.test(k) || !/^\d+$/.test(supply) || payoutPkh.length !== 40) return null;

  return { k, supply, payoutPkh, ticker: f5?.toString('utf8') || undefined };
}

/** Find the announcement among a transaction's outputs, if it carries one. */
export function findAnnouncement(outputs: { scriptHex: string }[]): PoolAnnouncement | null {
  for (const o of outputs) {
    const a = decodePoolAnnouncement(o.scriptHex);
    if (a) return a;
  }
  return null;
}
