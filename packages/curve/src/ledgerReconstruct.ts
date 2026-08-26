/**
 * ledgerReconstruct.ts — reconstruct a LedgerPool's op history FROM CHAIN ALONE (ADR-027).
 *
 * The trustless linchpin. `ledgerState.replay()` already rebuilds the exact on-chain
 * `LedgerPool` instance from an ordered op history and is proven byte-exact against real
 * mainnet successors. The one missing piece for a DB-free client is deriving that op history
 * from the blockchain instead of the operator's database — this module does that:
 *
 *   walk the pool's successor chain from genesis → for each hop, parse input-0's unlocking
 *   script into the op it performed `(ownerPkh, delta)` → hand the ordered list to replay().
 *
 * The unlock layout is fixed by scrypt-ts and verified against real buy/sell scripts:
 *   buy:  [ owner(20) , isNew(bool) , oldBal , delta      , newReserve , preimage , OP_0 ]
 *   sell: [ owner(20) , ownerPub(33), ownerSig, oldBal    , amount     , payout   , preimage , OP_1 ]
 *   graduate: [ preimage , OP_2 ]  (terminal — no ledger op, chain ends)
 * The LAST chunk is the public-method selector: OP_0 buy / OP_1 sell / OP_2 graduate.
 * arg0 is always the 20-byte owner pkh; the signed amount is at a fixed index per method.
 *
 * This is a pure parser — no network. A chain-walker feeds it (see reconstructLedgerHistory).
 */
import { Script } from '@bsv/sdk';

/** A single reconstructed pool operation: buy (delta > 0) or sell (delta < 0). */
export interface LedgerOp {
  ownerPkh: string; // 20-byte hash160, lowercase hex
  delta: bigint; // +credit on buy, −debit on sell
}

interface Chunk {
  op: number;
  data?: number[];
}

// scrypt-ts public-method selectors (index of the method in declaration order), pushed last.
const SELECTOR_BUY = 0; //  OP_0  → buy(owner, isNew, oldBal, delta, newReserve)
const SELECTOR_SELL = 81; // OP_1 → sell(owner, ownerPub, ownerSig, oldBal, amount, payout)
// SELECTOR_GRADUATE = 82 (OP_2) → graduate() : terminal, no ledger op.

// Fixed arg positions (chunk index) of the signed token amount within each unlock.
const BUY_DELTA_IDX = 3;
const SELL_AMOUNT_IDX = 4;

/** Read a non-negative Script integer from a chunk (minimal push OR OP_0 / OP_1..OP_16). */
function readScriptUint(c: Chunk): bigint {
  if (c.data && c.data.length > 0) {
    // little-endian scriptNum; token amounts are positive, so any sign byte is 0x00 (adds nothing)
    let v = 0n;
    for (let i = c.data.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(c.data[i] & 0xff);
    return v;
  }
  if (c.op === 0) return 0n; // OP_0
  if (c.op >= 81 && c.op <= 96) return BigInt(c.op - 80); // OP_1 .. OP_16
  throw new Error(`ledgerReconstruct: cannot read integer from opcode ${c.op}`);
}

const toHex = (data?: number[]): string =>
  data ? data.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('') : '';

/**
 * Parse one spent LedgerPool covenant input (its unlocking script) into the ledger op it
 * performed. Returns null for graduation, or for anything that is not a buy/sell ledger
 * unlock (defensive — callers only pass pool-input scripts).
 */
export function parseLedgerOp(unlockingScriptHex: string): LedgerOp | null {
  let chunks: Chunk[];
  try {
    chunks = Script.fromHex(unlockingScriptHex).chunks as unknown as Chunk[];
  } catch {
    return null;
  }
  if (chunks.length < 6) return null; // buy has 8, sell 9; below that isn't a ledger op

  const ownerPkh = toHex(chunks[0].data);
  if (ownerPkh.length !== 40) return null; // arg0 must be a 20-byte pkh

  const selector = chunks[chunks.length - 1].op;
  if (selector === SELECTOR_BUY) {
    return { ownerPkh, delta: readScriptUint(chunks[BUY_DELTA_IDX]) };
  }
  if (selector === SELECTOR_SELL) {
    return { ownerPkh, delta: -readScriptUint(chunks[SELL_AMOUNT_IDX]) };
  }
  return null; // graduate / not a ledger op
}

/**
 * Reconstruct the ordered op history from a genesis-to-tip sequence of pool-input unlocking
 * scripts (as produced by a chain-walk). Non-ops (graduation) are skipped. The result is
 * exactly the `Op[]`-shaped list that `ledgerState.replay()` / `poolScriptForHistory()`
 * consume — feed it there and assert the lockingScript byte-matches the on-chain tip.
 */
export function reconstructHistoryFromUnlocks(unlockingScriptHexes: string[]): LedgerOp[] {
  const ops: LedgerOp[] = [];
  for (const hex of unlockingScriptHexes) {
    const op = parseLedgerOp(hex);
    if (op) ops.push(op);
  }
  return ops;
}

/** A minimal view of a transaction the chain-walker fetches (WhatsOnChain-shaped). */
export interface WalkTx {
  txid: string;
  /** input scripts, indexed; only input 0 (the pool covenant spend) is parsed */
  inputUnlockHex: string[];
  /** output index of the pool successor (0 by convention), or -1 if the pool is not re-locked (graduation) */
  poolVout: number;
}

/**
 * Walk the pool's successor chain from genesis to the unspent tip, parsing each hop's op.
 *
 * `fetchSpendOf(txid, vout)` returns the tx that spends output `vout` of `txid` (its input-0
 * unlock is the next hop's op), or null when that output is unspent (the tip). `fetchSpendOf`
 * is injected so this stays network-agnostic and testable — a real caller backs it with a
 * WhatsOnChain "spent" lookup + tx fetch; the offline proof backs it with an in-memory map.
 *
 * Returns the ordered op history AND the tip outpoint (current pool UTXO). Hand `history` to
 * `poolScriptForHistory(history, k, supply, payoutPkh)` and assert it equals the tip's
 * on-chain lockingScript — that is the trustless reconstruction, DB-free.
 */
export async function reconstructLedgerHistory(
  genesisTxid: string,
  genesisVout: number,
  fetchSpendOf: (txid: string, vout: number) => Promise<WalkTx | null>,
  maxHops = 100_000,
): Promise<{ history: LedgerOp[]; tipTxid: string; tipVout: number }> {
  const history: LedgerOp[] = [];
  let curTxid = genesisTxid;
  let curVout = genesisVout;
  for (let hop = 0; hop < maxHops; hop++) {
    const spend = await fetchSpendOf(curTxid, curVout);
    if (!spend) return { history, tipTxid: curTxid, tipVout: curVout }; // current output unspent → tip
    const op = parseLedgerOp(spend.inputUnlockHex[0] ?? '');
    if (op) history.push(op);
    if (spend.poolVout < 0) return { history, tipTxid: spend.txid, tipVout: -1 }; // graduated, no successor
    curTxid = spend.txid;
    curVout = spend.poolVout;
  }
  throw new Error(`ledgerReconstruct: exceeded ${maxHops} hops walking the pool chain`);
}
