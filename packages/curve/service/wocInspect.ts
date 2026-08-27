/**
 * wocInspect.ts — read back what the CHAIN says, not what we computed.
 *
 * Two standing rules for anything touching mainnet in this repo, both learned the hard way:
 *
 *  1. **Never trust `/address/{addr}/unspent`.** It lists already-spent outputs, sometimes
 *     long-confirmed ones. That has produced a `258: txn-mempool-conflict` on a spend AND a
 *     reported balance of 942,880 sats when the verified figure was 482,948. Verify every candidate
 *     against `/tx/{txid}/{vout}/spent` (404 = genuinely unspent) before spending *or reporting*.
 *  2. **After broadcasting, download the transaction back and assert on THAT.** Locally computed
 *     size and fee are assumptions; the chain is evidence. Computed values have already hidden two
 *     real problems here — a fee estimate that double-counted the pool script, and a graduation
 *     check that summed outputs by script when the on-chain outputs said plainly that output 0 was
 *     exactly right.
 *
 * Both live here so every harness shares one implementation.
 */
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function woc(p: string, attempts = 6): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${WOC}${p}`, { cache: 'no-store' });
      if (r.ok || r.status === 404) return r;
    } catch { /* retry */ }
    if (i < attempts - 1) await sleep(2000 * (i + 1));
  }
  return null;
}

export interface Utxo { tx_hash: string; tx_pos: number; value: number; height: number }

/**
 * UTXOs that are VERIFIED unspent — each checked against `/spent`, not merely listed by `/unspent`.
 * Returns the stale total too, because reporting it is how the trap stays visible.
 */
export async function verifiedUnspent(address: string): Promise<{ utxos: Utxo[]; total: number; staleTotal: number; staleCount: number }> {
  const res = await woc(`/address/${address}/unspent`);
  if (!res || !res.ok) throw new Error('could not fetch UTXOs');
  const listed = (await res.json()) as Utxo[];
  listed.sort((a, b) => b.value - a.value);

  const utxos: Utxo[] = [];
  let staleTotal = 0, staleCount = 0;
  for (const u of listed) {
    const sp = await woc(`/tx/${u.tx_hash}/${u.tx_pos}/spent`);
    if (sp && sp.status === 404) utxos.push(u);
    else { staleTotal += u.value; staleCount++; }
  }
  return { utxos, total: utxos.reduce((s, u) => s + u.value, 0), staleTotal, staleCount };
}

/** Pick the largest verified-unspent UTXO worth at least `minSats`. */
export async function pickFunding(address: string, minSats: number): Promise<Utxo> {
  const { utxos, staleCount } = await verifiedUnspent(address);
  if (staleCount) console.log(`  (skipped ${staleCount} outputs WoC listed as unspent but which are already spent)`);
  const u = utxos.find((x) => x.value >= minSats);
  if (!u) throw new Error(`no VERIFIED-unspent UTXO >= ${minSats} sats at ${address}`);
  return u;
}

export interface TxFacts {
  txid: string;
  /** bytes, as the chain stores it */
  size: number;
  /** satoshis: sum(inputs) − sum(outputs), computed from the real parents */
  fee: number;
  feeRate: number;
  confirmations: number;
  blockHeight?: number;
  outputs: { n: number; satoshis: number; scriptHex: string; addresses: string[] }[];
  inputs: { txid: string; vout: number; satoshis: number }[];
}

/**
 * Download a broadcast transaction and report what the chain actually holds — size, fee, effective
 * rate, confirmations, and the real outputs. The fee is derived by fetching each parent output's
 * value, because WoC does not report a fee directly.
 */
export async function inspectTx(txid: string): Promise<TxFacts> {
  const res = await woc(`/tx/hash/${txid}`);
  if (!res || !res.ok) throw new Error(`could not fetch tx ${txid.slice(0, 12)}…`);
  const t = (await res.json()) as any;

  const outputs = (t.vout ?? []).map((o: any) => ({
    n: o.n,
    satoshis: Math.round((o.value ?? 0) * 1e8),
    scriptHex: (o.scriptPubKey?.hex ?? '').toLowerCase(),
    addresses: o.scriptPubKey?.addresses ?? [],
  }));

  const inputs: TxFacts['inputs'] = [];
  for (const vin of t.vin ?? []) {
    if (!vin.txid) continue; // coinbase
    const p = await woc(`/tx/hash/${vin.txid}`);
    if (!p || !p.ok) throw new Error(`could not fetch parent ${String(vin.txid).slice(0, 12)}…`);
    const pj = (await p.json()) as any;
    const po = (pj.vout ?? []).find((o: any) => o.n === vin.vout);
    inputs.push({ txid: vin.txid, vout: vin.vout, satoshis: Math.round((po?.value ?? 0) * 1e8) });
  }

  const inSats = inputs.reduce((s, i) => s + i.satoshis, 0);
  const outSats = outputs.reduce((s: number, o: any) => s + o.satoshis, 0);
  const size = t.size ?? 0;
  const fee = inSats - outSats;
  return {
    txid, size, fee, feeRate: size ? fee / size : 0,
    confirmations: t.confirmations ?? 0, blockHeight: t.blockheight,
    outputs, inputs,
  };
}

/** One-line summary of what the chain says about a transaction. */
export async function reportTx(txid: string, label = ''): Promise<TxFacts> {
  const f = await inspectTx(txid);
  console.log(
    `    chain says${label ? ` [${label}]` : ''}: ${f.size.toLocaleString()} B · fee ${f.fee.toLocaleString()} sats` +
    ` · ${f.feeRate.toFixed(4)} sat/B · ${f.confirmations > 0 ? `${f.confirmations} conf (block ${f.blockHeight})` : 'unconfirmed'}` +
    ` · ${f.outputs.length} outputs`,
  );
  return f;
}
