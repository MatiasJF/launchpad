/**
 * resolveLedgerPool.ts — DB-FREE, on-chain resolution of a LedgerPool (ADR-027, phase 2).
 *
 * Phase 1 proved the ledger can be rebuilt from unlock scripts alone (`ledgerReconstruct.ts`
 * + `verify-reconstruct.ts`, 17/17, offline). This backs that walk with the real chain:
 * WhatsOnChain spent-lookups + tx fetches, so a client with ONLY a genesis txid and the
 * pool's immutable terms (k, supply, payoutPkh — all baked into the covenant at deploy)
 * can recover the live pool outpoint, reserve, `sold`, and every holder balance, with **no
 * operator database**.
 *
 * SELF-VERIFYING WALK. Rather than guessing which output is the pool successor (a script
 * prefix heuristic), each hop recomputes the expected successor from the ops parsed so far
 * (`poolScriptForHistory`) and matches an output byte-for-byte. That means:
 *   - the successor is identified with zero ambiguity (no heuristic to get wrong),
 *   - EVERY hop is verified, not just the tip — a misparsed op fails immediately, at the
 *     hop that caused it, instead of surfacing as a confusing mismatch at the end,
 *   - graduation is detected naturally (no output re-locks the pool → the chain ends).
 *
 * scrypt-ts runs here (compiled service, never inside Next) — see ledger-service.ts.
 */
import { Op, poolScriptForHistory, genesisPoolScript } from './ledgerState';
import { parseLedgerOp, LedgerOp } from '../src/ledgerReconstruct';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

export interface PoolTerms {
  k: bigint;
  supply: bigint;
  payoutPkh: string;
}

export interface ResolvedLedgerPool {
  /** live pool outpoint (the unspent tip) */
  txid: string;
  vout: number;
  /** the tip's on-chain locking script — byte-equal to the reconstruction */
  scriptHex: string;
  /** reserve held by the live pool, in satoshis */
  reserveSats: number;
  /** tokens sold (== sum of balances) */
  sold: bigint;
  /** holder balances reconstructed from chain: pkh -> amount (zero balances omitted) */
  balances: Record<string, bigint>;
  /** the ordered op history, as parsed from the chain */
  history: LedgerOp[];
  /** number of pool spends walked */
  hops: number;
  /** true when the chain ended in a graduation (reserve released, pool not re-locked) */
  graduated: boolean;
}

interface WocVin {
  txid?: string;
  vout?: number;
  scriptSig?: { hex?: string };
}
interface WocVout {
  n: number;
  value?: number;
  scriptPubKey?: { hex?: string };
}
interface WocTx {
  txid: string;
  vin?: WocVin[];
  vout?: WocVout[];
}

/** Fetch with retry on transient WoC failures (429 rate-limit / 5xx / network). */
async function wocGet(path: string, attempts = 4): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${WOC}${path}`, { cache: 'no-store' });
      if (res.status === 404) return res; // definitive (means "unspent" on /spent)
      if (res.ok) return res;
      // 429 / 5xx → transient, retry
    } catch {
      /* network error → retry */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

/**
 * Who spends `txid:vout`? WoC returns 404 when the outpoint is UNSPENT (see field notes —
 * this 404-means-unspent behaviour is money-critical and has bitten us before) and a JSON
 * body naming the spending tx when it is spent.
 */
async function fetchSpender(txid: string, vout: number): Promise<{ spent: false } | { spent: true; spendingTxid: string } | null> {
  const res = await wocGet(`/tx/${txid}/${vout}/spent`);
  if (!res) return null; // couldn't determine
  if (res.status === 404) return { spent: false };
  const body = (await res.text()).trim();
  try {
    const t = (JSON.parse(body) as { txid?: string }).txid;
    if (t) return { spent: true, spendingTxid: t };
  } catch {
    /* non-JSON */
  }
  return null;
}

async function fetchTx(txid: string): Promise<WocTx | null> {
  const res = await wocGet(`/tx/hash/${txid}`);
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as WocTx;
  } catch {
    return null;
  }
}

const satsOf = (v?: number) => (typeof v === 'number' ? Math.round(v * 1e8) : 0);

/** Roll the parsed op history into holder balances (dropping any that net to zero). */
export function balancesFrom(history: LedgerOp[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const op of history) {
    const cur = out[op.ownerPkh] ?? 0n;
    out[op.ownerPkh] = cur + op.delta;
  }
  for (const k of Object.keys(out)) if (out[k] === 0n) delete out[k];
  return out;
}

/**
 * Resolve a ledger pool's CURRENT state from the blockchain alone.
 *
 * `genesisTxid[:vout]` is the deploy outpoint; `terms` are the immutable covenant
 * parameters. Walks the successor chain, parsing each spend into its ledger op and
 * verifying the successor byte-for-byte, until it reaches the unspent tip.
 *
 * Returns the live outpoint + fully reconstructed ledger, or `{ error }`. No DB is
 * consulted at any point — this is the trustless read path.
 */
export async function resolveLedgerPool(
  genesisTxid: string,
  terms: PoolTerms,
  opts: { genesisVout?: number; maxHops?: number; tipRechecks?: number; tipRecheckDelayMs?: number } = {},
): Promise<ResolvedLedgerPool | { error: string }> {
  const { genesisVout = 0, maxHops = 1000, tipRechecks = 2, tipRecheckDelayMs = 4000 } = opts;
  if (!/^[0-9a-fA-F]{64}$/.test(genesisTxid)) return { error: 'invalid genesis txid' };

  // The genesis output must actually be this pool's covenant — otherwise the caller has
  // the wrong outpoint or the wrong terms, and every later byte-match would fail anyway.
  const genesisTx = await fetchTx(genesisTxid);
  if (!genesisTx) return { error: `could not fetch genesis tx ${genesisTxid.slice(0, 10)}…` };
  const genesisOut = genesisTx.vout?.find((o) => o.n === genesisVout);
  const genesisScript = (genesisOut?.scriptPubKey?.hex ?? '').toLowerCase();
  if (!genesisScript) return { error: `genesis output ${genesisVout} not found` };
  const expectedGenesis = genesisPoolScript(terms.k, terms.supply, terms.payoutPkh).toLowerCase();
  if (genesisScript !== expectedGenesis) {
    return { error: 'genesis output does not match the given pool terms (wrong txid/vout, or wrong k/supply/payoutPkh)' };
  }

  const history: LedgerOp[] = [];
  let txid = genesisTxid;
  let vout = genesisVout;
  let scriptHex = genesisScript;
  let reserveSats = satsOf(genesisOut?.value);

  for (let hop = 0; hop < maxHops; hop++) {
    let spender = await fetchSpender(txid, vout);
    if (!spender) return { error: `could not check spent status of ${txid.slice(0, 10)}…:${vout} (WhatsOnChain unavailable)` };

    // "Unspent" is AMBIGUOUS at the tip: WoC returns the same 404 for a genuinely unspent
    // output and for one whose spend is in the mempool but not yet indexed. Reading the pool
    // moments after a trade therefore reports a stale tip and a short history — which is
    // exactly what a client would then try to spend, only to be rejected as a double-spend.
    // A genuinely-unspent tip stays unspent, so re-check before concluding. (Observed live:
    // the spent-index lagged a just-broadcast sell by seconds.)
    for (let r = 0; r < tipRechecks && spender && !spender.spent; r++) {
      await new Promise((res) => setTimeout(res, tipRecheckDelayMs));
      const again = await fetchSpender(txid, vout);
      if (again) spender = again;
    }
    if (!spender) return { error: `could not confirm spent status of ${txid.slice(0, 10)}…:${vout}` };

    if (!spender.spent) {
      // unspent, and still unspent on re-check → this is the live pool
      return {
        txid, vout, scriptHex, reserveSats,
        sold: history.reduce((s, o) => s + o.delta, 0n),
        balances: balancesFrom(history),
        history, hops: hop, graduated: false,
      };
    }

    const spendTx = await fetchTx(spender.spendingTxid);
    if (!spendTx) return { error: `could not fetch spending tx ${spender.spendingTxid.slice(0, 10)}…` };

    // Parse the op from the input that actually spends OUR outpoint (the pool input is
    // index 0 by construction, but matching the outpoint is what makes this correct).
    const vin = (spendTx.vin ?? []).find((i) => (i.txid ?? '').toLowerCase() === txid.toLowerCase() && i.vout === vout);
    if (!vin) return { error: `spending tx ${spender.spendingTxid.slice(0, 10)}… does not reference ${txid.slice(0, 10)}…:${vout}` };
    const op = parseLedgerOp(vin.scriptSig?.hex ?? '');

    if (!op) {
      // No ledger op parsed. That SHOULD mean graduation (terminal): the reserve was released to
      // the address fixed at deploy and the pool did not re-lock. But "unparseable" and "graduated"
      // are not the same claim — silently reporting a graduation for any script we failed to read
      // would turn a parser gap into a false "the sale completed". Confirm it: a real graduation
      // pays the committed payout script the full reserve.
      const payoutScript = `76a914${terms.payoutPkh.toLowerCase()}88ac`;
      const releasedTo = (spendTx.vout ?? []).find(
        (o) => (o.scriptPubKey?.hex ?? '').toLowerCase() === payoutScript && satsOf(o.value) === reserveSats,
      );
      if (!releasedTo) {
        return {
          error:
            `hop ${hop + 1} (${spender.spendingTxid.slice(0, 10)}…): the pool was spent by a transaction that is ` +
            `neither a buy/sell we can parse nor a graduation paying ${reserveSats} sats to the committed payout`,
        };
      }
      return {
        txid: spender.spendingTxid, vout: -1, scriptHex: '', reserveSats: 0,
        sold: history.reduce((s, o) => s + o.delta, 0n),
        balances: balancesFrom(history),
        history, hops: hop + 1, graduated: true,
      };
    }

    // Self-verifying: recompute the expected successor from the ops parsed SO FAR and
    // require an output to match it byte-for-byte. A misparse fails here, at its own hop.
    history.push(op);
    const expected = poolScriptForHistory(
      history.map((o) => ({ ownerPkh: o.ownerPkh, delta: o.delta.toString() })) as Op[],
      terms.k, terms.supply, terms.payoutPkh,
    ).toLowerCase();
    const successor = (spendTx.vout ?? []).find((o) => (o.scriptPubKey?.hex ?? '').toLowerCase() === expected);
    if (!successor) {
      return {
        error:
          `hop ${hop + 1} (${spender.spendingTxid.slice(0, 10)}…): no output matches the reconstructed successor ` +
          `for op ${op.ownerPkh.slice(0, 8)}…${op.delta > 0n ? '+' : ''}${op.delta} — the unlock parsed but the ledger diverged`,
      };
    }

    txid = spender.spendingTxid;
    vout = successor.n;
    scriptHex = expected;
    reserveSats = satsOf(successor.value);
  }
  return { error: `pool chain exceeded ${maxHops} hops` };
}
