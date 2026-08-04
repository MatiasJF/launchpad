'use server';

import { Beef, Transaction } from '@bsv/sdk';
import { isStasScript, stasOwnerPkh, stasTail, provenanceWalk } from '@launchpad/curve';

/**
 * Fetch a confirmed output's locking-script hex from WhatsOnChain (server-side,
 * no CORS). Used to reconstruct a STAS `source` UTXO for settlement.
 */
export async function getOutputScriptHex(txid: string, vout: number): Promise<string | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/out/${vout}/hex`, { cache: 'no-store' });
      if (res.ok) {
        const hex = (await res.text()).trim();
        if (/^[0-9a-fA-F]+$/.test(hex)) return hex;
      }
    } catch {
      /* transient — retry */
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 1500));
  }
  // Fallback: the /out/{vout}/hex endpoint only serves CONFIRMED txs, so it 404s for a
  // mempool tx (e.g. an unconfirmed operator delivery in a token's ancestry). The /tx/{txid}
  // JSON endpoint DOES return mempool txs and carries the same scriptPubKey.hex — use it so
  // back-to-genesis + vault resolution work over unconfirmed ancestry. Same bytes, not a weaker check.
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`, { cache: 'no-store' });
    if (res.ok) {
      const tx = (await res.json()) as { vout?: { n: number; scriptPubKey?: { hex?: string } }[] };
      const hex = (tx.vout?.find((o) => o.n === vout)?.scriptPubKey?.hex ?? '').toLowerCase();
      return /^[0-9a-fA-F]+$/.test(hex) ? hex : null;
    }
  } catch {
    /* fall through */
  }
  return null;
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
  // Retry transient WoC failures (rate limits / 5xx) instead of giving up — a
  // hiccup here otherwise breaks pool auto-resolution.
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`, { cache: 'no-store' });
      if (res.status === 404) return { unspent: true };
      if (res.ok) {
        const body = (await res.text()).trim();
        let spentBy: string | undefined;
        try {
          spentBy = (JSON.parse(body) as { txid?: string }).txid;
        } catch {
          /* non-JSON body — leave spentBy undefined */
        }
        return { unspent: false, spentBy };
      }
      // non-ok, non-404 → transient; retry
    } catch {
      /* network error → retry */
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 1500));
  }
  return { unspent: null };
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
  // Retry the mint fetch: right after issuance the mint may not be indexed by WoC
  // yet, which used to make auto-resolve give up on mount. A few spaced retries
  // ride out that propagation lag.
  let mintScript: string | null = null;
  for (let i = 0; i < 5 && !mintScript; i++) {
    mintScript = await getOutputScriptHex(mintTxid, 0);
    if (!mintScript && i < 4) await new Promise((r) => setTimeout(r, 2500));
  }
  if (!mintScript) return { error: 'could not fetch mint output script — the mint may still be confirming; retry shortly' };
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
 * List the operator BASE address's spendable UTXOs from WhatsOnChain (server-side, no
 * CORS). Powers the flat-key operator fee funding (ADR-028 revised) that replaced the
 * `@bsv/wallet-toolbox` custody on the trade path. Merges CONFIRMED + UNCONFIRMED unspent
 * (an operator base UTXO is often unconfirmed change from a prior op) and drops any that
 * are already spent in the mempool (isOutputUnspent), so back-to-back trades don't try to
 * spend a UTXO a pending tx already consumed. Tolerant of WoC's array vs `{result:[]}`
 * response shapes. Returns `{ txid, vout, satoshis }[]`.
 */
export async function getOperatorBaseUtxos(
  address: string,
): Promise<{ txid: string; vout: number; satoshis: number }[]> {
  if (!address) return [];
  const parse = (body: unknown): { txid: string; vout: number; satoshis: number }[] => {
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { result?: unknown })?.result)
        ? ((body as { result: unknown[] }).result)
        : [];
    const out: { txid: string; vout: number; satoshis: number }[] = [];
    for (const r of rows as { tx_hash?: string; tx_pos?: number; value?: number }[]) {
      const txid = (r.tx_hash ?? '').toLowerCase();
      const vout = r.tx_pos;
      const satoshis = r.value;
      if (/^[0-9a-f]{64}$/.test(txid) && Number.isInteger(vout) && typeof satoshis === 'number' && satoshis > 0) {
        out.push({ txid, vout: vout as number, satoshis });
      }
    }
    return out;
  };

  const endpoints = [
    `https://api.whatsonchain.com/v1/bsv/main/address/${address}/confirmed/unspent`,
    `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unconfirmed/unspent`,
    `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`, // legacy fallback
  ];
  const seen = new Set<string>();
  const merged: { txid: string; vout: number; satoshis: number }[] = [];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      for (const u of parse(await res.json())) {
        const key = `${u.txid}:${u.vout}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(u);
        }
      }
    } catch {
      /* transient — try next endpoint */
    }
  }
  // Drop any UTXO already spent by a pending tx (mempool-aware spent check).
  const live: { txid: string; vout: number; satoshis: number }[] = [];
  for (const u of merged) {
    const s = await isOutputUnspent(u.txid, u.vout);
    if (s.unspent !== false) live.push(u); // keep true + unverifiable (broadcast is the backstop)
  }
  // Prefer UTXOs whose unconfirmed ancestry is SHALLOW. A base UTXO sitting on a deep
  // unconfirmed chain (e.g. a leftover from a prior stuck/underfeed run) would push a new
  // run's ~10 txs past the node's 25-ancestor mempool limit → "too-long-mempool-chain".
  // Keep only UTXOs with ≤ 10 unconfirmed ancestors (confirmed = 0), leaving headroom.
  const shallow: { txid: string; vout: number; satoshis: number }[] = [];
  for (const u of live) {
    const depth = await unconfirmedAncestorCount(u.txid, 12);
    if (depth <= 10) shallow.push(u);
  }
  return shallow.length ? shallow : live; // fall back to live if all are deep (broadcast backstops)
}

/**
 * Count distinct UNCONFIRMED ancestor txs of `txid` (bounded by `cap`), stopping each
 * branch at the first confirmed tx. Used to avoid selecting a base fee UTXO whose deep
 * unconfirmed chain would blow the node's 25-ancestor mempool limit. A confirmed txid → 0.
 */
async function unconfirmedAncestorCount(txid: string, cap: number): Promise<number> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Throttled + retried fetch so a deep chain isn't UNDERcounted by rate-limit gaps
  // (which would wrongly keep a stuck UTXO). Returns null only after persistent failure.
  const fetchTx = async (t: string): Promise<{ confirmed: boolean; vin: string[] } | null> => {
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${t}`, { cache: 'no-store' });
        if (res.ok) {
          const d = (await res.json()) as { confirmations?: number; blockheight?: number; vin?: { txid?: string }[] };
          return {
            confirmed: (d.confirmations ?? 0) > 0 || !!d.blockheight,
            vin: (d.vin ?? []).map((v) => v.txid).filter((x): x is string => typeof x === 'string'),
          };
        }
      } catch {
        /* transient — retry */
      }
      await sleep(400 + i * 400);
    }
    return null;
  };
  const seen = new Set<string>();
  let frontier = [txid];
  while (frontier.length > 0 && seen.size <= cap) {
    const next: string[] = [];
    for (const t of frontier) {
      if (seen.has(t) || !/^[0-9a-f]{64}$/.test(t)) continue;
      const info = await fetchTx(t);
      if (info === null) return cap + 2; // FAIL-CLOSED: can't verify → treat as deep, skip the UTXO
      if (info.confirmed) continue; // confirmed boundary — do not count, stop this branch
      seen.add(t);
      for (const v of info.vin) next.push(v);
      await sleep(120); // stay under WoC's rate limit so the count is accurate
    }
    frontier = next;
  }
  return seen.size;
}

/**
 * Broadcast an ATOMIC BEEF's whole unconfirmed chain to WhatsOnChain, parents-first,
 * multi-pass + throttled — the proven flush from `operator-fund.mjs`, now shared for the
 * flat-key operator trade path (ADR-028 revised). The BEEF's tip is the tx we want live;
 * its leaves are anchored at confirmed roots. We reconstruct the tip (with its ancestry
 * links populated from the BEEF), collect every UNCONFIRMED ancestor (skipping confirmed
 * boundaries), and push them parents-before-children so WoC's single-tx endpoint always
 * sees each parent present. Returns the tip's broadcast verdict.
 */
export async function broadcastBeefChain(
  beefBytes: number[],
  expectedTipTxid?: string,
): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  let tip: Transaction;
  try {
    tip = Transaction.fromAtomicBEEF(beefBytes);
  } catch (e) {
    return { ok: false, error: `bad atomic BEEF: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Collect unconfirmed ancestors, parents-before-children (a tx with a merklePath is a
  // confirmed boundary — stop there).
  const seen = new Set<string>();
  const chain: Transaction[] = [];
  const collect = (tx: Transaction): void => {
    for (const inp of tx.inputs) {
      const src = inp.sourceTransaction;
      if (!src || src.merklePath) continue;
      collect(src);
      const id = src.id('hex');
      if (!seen.has(id)) {
        seen.add(id);
        chain.push(src);
      }
    }
  };
  collect(tip);

  const tipId = tip.id('hex');
  let pending = [...chain, tip].map((t) => ({ hex: t.toHex(), id: t.id('hex') }));
  let tipResult: { ok: true; txid: string } | { ok: false; error: string } = { ok: false, error: 'tip not broadcast' };

  for (let pass = 0; pending.length && pass < 8; pass++) {
    const next: typeof pending = [];
    let progressed = false;
    for (const t of pending) {
      const r = await broadcastRawTx(t.hex, t.id);
      if (t.id === tipId) tipResult = r.ok ? { ok: true, txid: r.txid || tipId } : { ok: false, error: r.error };
      if (r.ok) progressed = true;
      else next.push(t);
      await new Promise((res) => setTimeout(res, 450)); // ~2 req/s, under WoC free-tier
    }
    pending = next;
    if (!progressed) break; // a full pass landed nothing new — stop
  }

  if (tipResult.ok && expectedTipTxid && !tipResult.txid) return { ok: true, txid: expectedTipTxid };
  return tipResult;
}

/**
 * Find the STAS output in a tx that is locked to `ownerPkh` and carries exactly
 * `amount` tokens (1 sat = 1 token). Used to locate the seller's STAS-return output
 * (the tokens they sent to the operator vault) before refunding. Returns its vout +
 * script, or null. Server-side WoC read (no CORS).
 */
export async function findStasOutputToPkh(
  txid: string,
  ownerPkh: string,
  amount: number,
): Promise<{ vout: number; scriptHex: string; satoshis: number } | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !/^[0-9a-fA-F]{40}$/.test(ownerPkh)) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`, { cache: 'no-store' });
      if (res.ok) {
        const tx = (await res.json()) as { vout?: { n: number; value?: number; scriptPubKey?: { hex?: string } }[] };
        for (const o of tx.vout ?? []) {
          const hex = (o.scriptPubKey?.hex ?? '').toLowerCase();
          const sats = typeof o.value === 'number' ? Math.round(o.value * 1e8) : -1;
          if (isStasScript(hex) && stasOwnerPkh(hex) === ownerPkh.toLowerCase() && sats === Math.floor(amount)) {
            return { vout: o.n, scriptHex: hex, satoshis: sats };
          }
        }
        return null; // tx fetched, no matching STAS output
      }
    } catch {
      /* transient — retry */
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** Fetch a tx's inputs (prevout outpoints) + outputs (n, script, sats) from WoC. */
async function fetchTxIO(
  txid: string,
): Promise<{ vin: { txid: string; vout: number }[]; vout: { n: number; hex: string; sats: number }[] } | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`, { cache: 'no-store' });
      if (res.ok) {
        const tx = (await res.json()) as { vin?: { txid?: string; vout?: number }[]; vout?: { n: number; value?: number; scriptPubKey?: { hex?: string } }[] };
        const vin = (tx.vin ?? []).filter((v) => typeof v.txid === 'string' && typeof v.vout === 'number').map((v) => ({ txid: v.txid as string, vout: v.vout as number }));
        const vout = (tx.vout ?? []).map((o) => ({ n: o.n, hex: (o.scriptPubKey?.hex ?? '').toLowerCase(), sats: typeof o.value === 'number' ? Math.round(o.value * 1e8) : -1 }));
        return { vin, vout };
      }
    } catch {
      /* transient — retry */
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * BACK-TO-GENESIS full-provenance authenticity (ADR-024/028 step-3, hardened). Verify
 * that the STAS UTXO at `outpointTxid:outpointVout` is a GENUINE token of the operator's
 * own mint — and that EVERY token in it is backed by genuine issuance, not just one
 * ancestor. The operator minted the whole supply itself (step 1), so authenticity ==
 * "the whole amount descends from OUR issuance".
 *
 * Naive existence walks (break on the FIRST genuine ancestor) are exploitable: an
 * attacker buys 1 genuine token, fabricates a same-tail COUNTERFEIT output for the rest
 * (mintable from a plain P2PKH with no STAS parent — the ADR-025 asymmetry), merges them
 * into a δ-token return; a first-match walk sees the 1 genuine ancestor and passes,
 * refunding δ and draining the reserve. So we require FULL provenance:
 *   `genuine(tx)` ⇔ tx IS the issuance, OR every same-tail STAS input of tx is itself
 *   `genuine`, AND tx conserves same-tail tokens (Σ same-tail outputs ≤ Σ same-tail
 *   inputs — no unbacked/injected tokens). A tx that emits a same-tail output with ZERO
 *   same-tail STAS inputs (a fabricated mint) is NOT genuine → the whole return is
 *   rejected. Because STAS conserves amount per tx and every merge input must be genuine,
 *   the returned amount is fully backed.
 *
 * The ancestry is a DAG (merges), so the walk is memoised by txid and BOUNDED by a node
 * budget; it is FAIL-CLOSED — any fetch gap, a cycle, exceeding the budget (an attacker
 * may fabricate deep/wide provenance to DoS), tail mismatch, or unbacked ancestry all
 * return `authentic:false`. An operator legitimately refuses to refund a return whose
 * provenance it cannot fully verify. Call this and require `authentic` BEFORE co-signing.
 */
export async function verifyStasBackToGenesis(input: {
  outpointTxid: string;
  outpointVout: number;
  issuanceTxid: string;
}): Promise<{ authentic: boolean; nodes?: number; reason?: string }> {
  const { outpointTxid, outpointVout, issuanceTxid } = input;
  if (!/^[0-9a-fA-F]{64}$/.test(outpointTxid) || !/^[0-9a-fA-F]{64}$/.test(issuanceTxid) || !Number.isInteger(outpointVout) || outpointVout < 0) {
    return { authentic: false, reason: 'invalid txid/vout' };
  }
  // The genuine token tail comes from the operator's own genesis STAS output (issue:0).
  const genesisScript = await getOutputScriptHex(issuanceTxid, 0);
  if (!genesisScript || !isStasScript(genesisScript)) return { authentic: false, reason: 'could not read a STAS genesis output at issuance:0' };
  const genuineTail = stasTail(genesisScript);

  // Delegate to the pure, unit-tested full-provenance walk with WoC-backed fetchers.
  return provenanceWalk(outpointTxid, outpointVout, {
    issuanceTxid,
    genuineTail,
    getOutput: async (txid, vout) => {
      const info = await getOutputInfo(txid, vout);
      return info ? { scriptHex: info.scriptHex, sats: info.satoshis } : null;
    },
    getTxIO: fetchTxIO,
    maxNodes: 400,
  });
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
    return hexToBytes(hex);
  } catch {
    return null;
  }
}

/** hex → byte array (WoC returns tx/beef as hex). */
function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substring(i, i + 2), 16));
  return bytes;
}

/** Fetch a tx's RAW serialized bytes (hex) from WoC — works for UNCONFIRMED txs too
 * (unlike `/beef`, which needs a mined merkle proof). Server-side, no CORS. */
async function fetchRawTxHex(txid: string): Promise<string | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`, { cache: 'no-store' });
      if (res.ok) {
        const hex = (await res.text()).trim();
        return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 ? hex : null;
      }
    } catch {
      /* transient — retry */
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * UNCONFIRMED-SAFE ancestry BEEF for a STAS source UTXO (ADR-028 delivery robustness).
 *
 * `getSourceBeef` fetches WoC `/tx/{txid}/beef`, which ONLY returns a BEEF for a
 * CONFIRMED tx (it needs the merkle BUMP). A fresh mint — and every subsequent vault
 * hop, which moves the vault to a NEW unconfirmed tx — is unconfirmed, so that path
 * 404s and delivery aborts even though the operator can spend the raw UTXO fine. That
 * left buyers who PAID (TX-A landed, pool advanced) with no tokens and no retry.
 *
 * This builds a valid ancestry BEEF whose TIP may be unconfirmed:
 *   • Cheap path — if the tip itself is confirmed, WoC `/beef` is already a complete,
 *     bump-anchored SPV proof; use it verbatim.
 *   • Deep path — walk the ancestry from the (unconfirmed) tip: `mergeRawTx` each
 *     unconfirmed tx, then recurse into ALL of its parent inputs; when a parent is
 *     CONFIRMED, merge its `/beef` (which carries the merkle BUMP) and STOP that branch
 *     — the bump anchors it to a mined root. The result is a BEEF whose leaves reach
 *     confirmed, mined roots even though the tip is not yet mined.
 *
 * Bounded (visited set + node budget) and FAIL-CLOSED: any fetch gap, a walk that can't
 * reach a confirmed root within budget, or a BEEF that fails to assemble/verify returns
 * null — never a partial/unanchored BEEF (it is SPV-critical for the buyer). We VERIFY
 * by round-tripping through `Beef.fromBinary` and requiring `findAtomicTransaction(tip)`
 * to resolve (proves the ancestry is complete + anchored for the tip).
 */
export async function getSourceBeefDeep(txid: string): Promise<number[] | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return null;
  const tip = txid.toLowerCase();

  // Cheap path first: a confirmed tip's /beef is already a full SPV anchor.
  const direct = await getSourceBeef(tip);
  if (direct) return direct;

  const beef = new Beef();
  const visited = new Set<string>();
  const MAX_NODES = 200; // bound the DAG walk (fabricated deep/wide ancestry → fail closed)
  let count = 0;

  async function walk(id: string): Promise<boolean> {
    const key = id.toLowerCase();
    if (visited.has(key)) return true;
    if (++count > MAX_NODES) return false; // budget exhausted → fail closed
    visited.add(key);

    // Anchored? A CONFIRMED ancestor's /beef is self-sufficient (tx + merkle bump).
    const confirmed = await getSourceBeef(key);
    if (confirmed) {
      try {
        beef.mergeBeef(confirmed);
        return true; // branch anchored to a mined root — stop
      } catch {
        return false;
      }
    }

    // UNCONFIRMED → merge raw bytes, then recurse into every parent input so the whole
    // input DAG reaches proofs (a BEEF is valid only if each tx chains back to a bump).
    const rawHex = await fetchRawTxHex(key);
    if (!rawHex) return false;
    let parents: string[];
    try {
      beef.mergeRawTx(hexToBytes(rawHex));
      const tx = Transaction.fromHex(rawHex);
      parents = tx.inputs
        .map((i) => (i.sourceTXID ?? '').toLowerCase())
        .filter((t) => /^[0-9a-f]{64}$/.test(t));
    } catch {
      return false;
    }
    if (parents.length === 0) return false; // no traceable parents → can't anchor
    for (const p of parents) {
      if (!(await walk(p))) return false;
    }
    return true;
  }

  if (!(await walk(tip))) return null;

  // VERIFY: round-trip parse + the tip must resolve to a complete, anchored atomic tx.
  try {
    const bytes = beef.toBinary();
    const parsed = Beef.fromBinary(bytes);
    if (!parsed.findAtomicTransaction(tip)) return null; // incomplete/unanchored → fail closed
    return bytes;
  } catch {
    return null;
  }
}
