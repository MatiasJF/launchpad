/**
 * cli.ts — stateless JSON-in/JSON-out wrapper around the LedgerPool state service.
 * Invoked as a child process by the web server so scrypt-ts is never bundled into
 * Next.js. BigInts cross as decimal strings; the pool's op HISTORY crosses as an
 * ordered array of {ownerPkh, delta}.
 */
import { computeBuySpend, computeSellDigest, computeSellUnlock, computeGraduate, genesisPoolScript, type Op } from './ledgerState';
import { stasGenesisScript } from './stasState';
import * as merkle from './merkleLedgerState';
import { resolveMerkleLedgerPool } from './resolveMerkleLedgerPool';

type Json = Record<string, unknown>;
const B = (s: unknown): bigint => BigInt(String(s));
const S = (s: unknown): string => String(s);
const history = (raw: any[]): Op[] => (raw ?? []).map((o) => ({ ownerPkh: String(o.ownerPkh), delta: String(o.delta) }));

// ── ADR-030 (Merkle ledger) helpers ──────────────────────────────────────────
// Ops cross as SLOT-addressed, because a chain reconstruction must replay recorded slots rather
// than re-derive them (an open protocol means other clients exist — see merkleLedgerState).
const terms = (i: Json): merkle.PoolTerms => ({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh) });
const slotOps = (raw: any[]): merkle.SlotOp[] => (raw ?? []).map((o) => ({
  ownerPkh: String(o.ownerPkh), slotIndex: Number(o.slotIndex), delta: BigInt(String(o.delta)), isNew: Boolean(o.isNew),
}));

function main(): void | Promise<void> {
  const action = process.argv[2];
  const i: Json = JSON.parse(process.argv[3] ?? '{}');
  let out: Json;

  if (action === 'genesis') {
    out = { scriptHex: genesisPoolScript(B(i.k), B(i.supply), S(i.payoutPkh)) };
  } else if (action === 'stas-genesis') {
    out = { scriptHex: stasGenesisScript(B(i.k), B(i.supply), S(i.operatorPkh)) };
  } else if (action === 'buy') {
    const r = computeBuySpend({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), ownerPkh: S(i.ownerPkh), delta: B(i.delta), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), newReserve: Number(i.newReserve) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex };
  } else if (action === 'sell-digest') {
    const r = computeSellDigest({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), ownerPkh: S(i.ownerPkh), amount: B(i.amount), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), payoutScriptHex: S(i.payoutScriptHex) });
    out = { digestHex: r.digestHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, payoutScriptHex: r.payoutScriptHex, refund: r.refund.toString(), reserveAfter: r.reserveAfter };
  } else if (action === 'sell-unlock') {
    const r = computeSellUnlock({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), ownerPkh: S(i.ownerPkh), ownerPubHex: S(i.ownerPubHex), amount: B(i.amount), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), payoutScriptHex: S(i.payoutScriptHex), sigDerHex: S(i.sigDerHex) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, refund: r.refund.toString() };
  } else if (action === 'graduate') {
    const r = computeGraduate({ k: B(i.k), supply: B(i.supply), payoutPkh: S(i.payoutPkh), history: history(i.history as any[]), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, payoutScriptHex: r.payoutScriptHex, reserve: r.reserve };
  // ── ADR-030: the bounded-size Merkle-ledger pool ───────────────────────────
  } else if (action === 'merkle-genesis') {
    out = { scriptHex: merkle.genesisScript(terms(i)) };
  } else if (action === 'merkle-resolve') {
    // The whole point of ADR-030's reconstruction: pool state comes from the CHAIN, so the web app
    // holds no authoritative ledger mirror at all — only the immutable terms and the genesis txid.
    return resolveMerkleLedgerPool(S(i.genesisTxid), terms(i), { genesisVout: Number(i.genesisVout ?? 0) })
      .then((r) => {
        const body = 'error' in r ? { error: r.error } : {
          txid: r.txid, vout: r.vout, scriptHex: r.scriptHex, reserveSats: r.reserveSats,
          sold: r.sold.toString(), holderCount: r.holderCount, graduated: r.graduated, hops: r.hops,
          rootHex: r.rootHex,
          balances: Object.fromEntries(Object.entries(r.balances).map(([k, v]) => [k, v.toString()])),
          slots: r.slots.map((sl) => ({ index: sl.index, ownerPkh: sl.ownerPkh, balance: sl.balance.toString() })),
          history: r.history.map((o) => ({ ownerPkh: o.ownerPkh, slotIndex: o.slotIndex, delta: o.delta.toString(), isNew: o.isNew })),
        };
        process.stdout.write(JSON.stringify(body));
      });
  } else if (action === 'merkle-buy') {
    const r = merkle.computeBuySpend({ terms: terms(i), history: slotOps(i.history as any[]), ownerPkh: S(i.ownerPkh), delta: B(i.delta), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), newReserve: Number(i.newReserve) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, cost: r.cost.toString() };
  } else if (action === 'merkle-sell-digest') {
    const r = merkle.computeSellDigest({ terms: terms(i), history: slotOps(i.history as any[]), ownerPkh: S(i.ownerPkh), amount: B(i.amount), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), payoutScriptHex: S(i.payoutScriptHex) });
    out = { digestHex: r.digestHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, refund: r.refund.toString(), reserveAfter: r.reserveAfter };
  } else if (action === 'merkle-sell-unlock') {
    const r = merkle.computeSellUnlock({ terms: terms(i), history: slotOps(i.history as any[]), ownerPkh: S(i.ownerPkh), ownerPubHex: S(i.ownerPubHex), amount: B(i.amount), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore), payoutScriptHex: S(i.payoutScriptHex), sigDerHex: S(i.sigDerHex) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, refund: r.refund.toString(), reserveAfter: r.reserveAfter };
  } else if (action === 'merkle-graduate') {
    const r = merkle.computeGraduate({ terms: terms(i), history: slotOps(i.history as any[]), poolTxid: S(i.poolTxid), poolVout: Number(i.poolVout), reserveBefore: Number(i.reserveBefore) });
    out = { unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, payoutScriptHex: r.payoutScriptHex };
  } else {
    process.stderr.write(`unknown action: ${action}\n`);
    process.exit(2); return;
  }
  process.stdout.write(JSON.stringify(out));
}

try { main(); } catch (e: any) { process.stderr.write('ERR: ' + (e?.message ?? String(e)) + '\n'); process.exit(1); }
