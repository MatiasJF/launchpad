/**
 * resolveMerkleLedgerPool.ts — DB-free, on-chain resolution of an ADR-030 pool.
 *
 * The ADR-027 resolver's counterpart, adapted to the bounded-size covenant. Two things change,
 * and both make the result stronger:
 *
 *  - **Slot-addressed replay.** Each spend records WHICH slot it rewrote, so the reconstruction
 *    follows the chain exactly instead of re-deriving slots and hoping it agrees.
 *  - **The root is checkable directly.** This covenant's state is three plain scalars, so the
 *    reconstructed tree's root can be compared against the root sitting in the on-chain script.
 *    That is a sharper failure signal than a whole-script mismatch: it says the LEDGER diverged,
 *    not merely that some byte did.
 *
 * As before the walk is self-verifying — each hop recomputes the expected successor and matches an
 * output byte-for-byte — so a misparse fails at the hop that caused it.
 */
import { poolScriptForHistory, poolScriptForSlotOps, PoolTerms } from './merkleLedgerState';
import { parseMerkleOp, MerkleOp } from '../src/merkleLedgerReconstruct';
import { replayMerkleSlots, MerkleLedger } from '../src/merkleLedger';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

export interface ResolvedMerklePool {
  txid: string;
  vout: number;
  scriptHex: string;
  reserveSats: number;
  sold: bigint;
  holderCount: number;
  /** aggregated per holder (a holder may occupy several slots) */
  balances: Record<string, bigint>;
  /** every occupied slot, in index order */
  slots: { index: number; ownerPkh: string; balance: bigint }[];
  /** the Merkle root of the reconstructed ledger */
  rootHex: string;
  history: MerkleOp[];
  hops: number;
  graduated: boolean;
}

interface WocVin { txid?: string; vout?: number; scriptSig?: { hex?: string } }
interface WocVout { n: number; value?: number; scriptPubKey?: { hex?: string } }
interface WocTx { txid: string; vin?: WocVin[]; vout?: WocVout[] }

async function wocGet(path: string, attempts = 5): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${WOC}${path}`, { cache: 'no-store' });
      if (res.status === 404 || res.ok) return res;
    } catch { /* retry */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return null;
}

async function fetchSpender(txid: string, vout: number): Promise<{ spent: false } | { spent: true; spendingTxid: string } | null> {
  const res = await wocGet(`/tx/${txid}/${vout}/spent`);
  if (!res) return null;
  if (res.status === 404) return { spent: false }; // 404 == unspent (see the BSV field notes)
  try {
    const t = (JSON.parse((await res.text()).trim()) as { txid?: string }).txid;
    if (t) return { spent: true, spendingTxid: t };
  } catch { /* non-JSON */ }
  return null;
}

async function fetchTx(txid: string): Promise<WocTx | null> {
  const res = await wocGet(`/tx/hash/${txid}`);
  if (!res || !res.ok) return null;
  try { return (await res.json()) as WocTx; } catch { return null; }
}

const satsOf = (v?: number) => (typeof v === 'number' ? Math.round(v * 1e8) : 0);

function summarise(ledger: MerkleLedger, history: MerkleOp[]) {
  return {
    sold: history.reduce((s, o) => s + o.delta, 0n),
    holderCount: ledger.holderCount,
    balances: ledger.balances(),
    slots: ledger.entries(),
    rootHex: ledger.root().toString('hex'),
  };
}

/**
 * Resolve an ADR-030 pool's current state from the blockchain alone.
 *
 * `tipRechecks` guards WhatsOnChain's mempool lag: a bare 404 on `/spent` means both "unspent"
 * and "the spend isn't indexed yet", so a read moments after a trade would otherwise report a
 * stale tip and a truncated history.
 */
export async function resolveMerkleLedgerPool(
  genesisTxid: string,
  terms: PoolTerms,
  opts: { genesisVout?: number; maxHops?: number; tipRechecks?: number; tipRecheckDelayMs?: number } = {},
): Promise<ResolvedMerklePool | { error: string }> {
  const { genesisVout = 0, maxHops = 5000, tipRechecks = 2, tipRecheckDelayMs = 4000 } = opts;
  if (!/^[0-9a-fA-F]{64}$/.test(genesisTxid)) return { error: 'invalid genesis txid' };

  const genesisTx = await fetchTx(genesisTxid);
  if (!genesisTx) return { error: `could not fetch genesis tx ${genesisTxid.slice(0, 10)}…` };
  const genesisOut = genesisTx.vout?.find((o) => o.n === genesisVout);
  const genesisScript = (genesisOut?.scriptPubKey?.hex ?? '').toLowerCase();
  if (!genesisScript) return { error: `genesis output ${genesisVout} not found` };
  if (genesisScript !== poolScriptForHistory([], terms).toLowerCase()) {
    return { error: 'genesis output does not match the given pool terms (wrong outpoint, or wrong k/supply/payoutPkh)' };
  }

  const history: MerkleOp[] = [];
  let txid = genesisTxid;
  let vout = genesisVout;
  let scriptHex = genesisScript;
  let reserveSats = satsOf(genesisOut?.value);

  for (let hop = 0; hop < maxHops; hop++) {
    let spender = await fetchSpender(txid, vout);
    if (!spender) return { error: `could not check spent status of ${txid.slice(0, 10)}…:${vout}` };
    for (let r = 0; r < tipRechecks && spender && !spender.spent; r++) {
      await new Promise((res) => setTimeout(res, tipRecheckDelayMs));
      const again = await fetchSpender(txid, vout);
      if (again) spender = again;
    }
    if (!spender) return { error: `could not confirm spent status of ${txid.slice(0, 10)}…:${vout}` };

    if (!spender.spent) {
      const led = replayMerkleSlots(history);
      return { txid, vout, scriptHex, reserveSats, ...summarise(led, history), history, hops: hop, graduated: false };
    }

    const spendTx = await fetchTx(spender.spendingTxid);
    if (!spendTx) return { error: `could not fetch spending tx ${spender.spendingTxid.slice(0, 10)}…` };
    const vin = (spendTx.vin ?? []).find((i) => (i.txid ?? '').toLowerCase() === txid.toLowerCase() && i.vout === vout);
    if (!vin) return { error: `spending tx ${spender.spendingTxid.slice(0, 10)}… does not reference ${txid.slice(0, 10)}…:${vout}` };
    const op = parseMerkleOp(vin.scriptSig?.hex ?? '');

    if (!op) {
      // Should be a graduation. Confirm it actually paid the committed payout the whole reserve —
      // an unparseable spend must not be reported as "the sale completed".
      const payoutScript = `76a914${terms.payoutPkh.toLowerCase()}88ac`;
      const paid = (spendTx.vout ?? []).find(
        (o) => (o.scriptPubKey?.hex ?? '').toLowerCase() === payoutScript && satsOf(o.value) === reserveSats,
      );
      if (!paid) {
        return { error: `hop ${hop + 1} (${spender.spendingTxid.slice(0, 10)}…): pool spent by a tx that is neither a parseable buy/sell nor a graduation paying ${reserveSats} sats to the committed payout` };
      }
      const led = replayMerkleSlots(history);
      return {
        txid: spender.spendingTxid, vout: -1, scriptHex: '', reserveSats: 0,
        ...summarise(led, history), history, hops: hop + 1, graduated: true,
      };
    }

    history.push(op);
    let expected: string;
    try {
      expected = poolScriptForSlotOps(history, terms).toLowerCase();
    } catch (e) {
      return { error: `hop ${hop + 1}: replaying the parsed ops failed — ${e instanceof Error ? e.message : String(e)}` };
    }
    const successor = (spendTx.vout ?? []).find((o) => (o.scriptPubKey?.hex ?? '').toLowerCase() === expected);
    if (!successor) {
      return {
        error: `hop ${hop + 1} (${spender.spendingTxid.slice(0, 10)}…): no output matches the reconstructed successor for slot ${op.slotIndex} ${op.delta > 0n ? '+' : ''}${op.delta} — the unlock parsed but the ledger diverged`,
      };
    }

    txid = spender.spendingTxid;
    vout = successor.n;
    scriptHex = expected;
    reserveSats = satsOf(successor.value);
  }
  return { error: `pool chain exceeded ${maxHops} hops` };
}
