/**
 * merkleLedgerReconstruct.ts — parse ADR-030 pool spends back into ledger operations.
 *
 * The ADR-027 counterpart (`ledgerReconstruct.ts`) only needed `(ownerPkh, delta)`, because a
 * HashedMap keyed balances by owner. This covenant addresses balances by SLOT, so the parser must
 * also recover which slot a spend touched, and whether it appended a new one. Reconstructing by
 * "the owner's first slot" would be a guess: a client is free to append a second slot for an owner
 * who already has one (harmless to the reserve — see ADR-030 — but it moves the tree), and a
 * reconstruction that guessed differently from the chain would produce a root that doesn't match.
 *
 * Layout, verified against real compiled output (`service/inspect-merkle-unlock.ts`):
 *
 *   buy       [ owner(20) | path×16 | siblings×16 | isNew | oldBal | delta | newReserve
 *               | preimage | OP_0 ]                                          39 chunks
 *   sell      [ owner(20) | ownerPub(33) | ownerSig | path×16 | siblings×16 | oldBal | amount
 *               | payoutScript | preimage | OP_1 ]                           40 chunks
 *   graduate  [ preimage | OP_2 ]                                             2 chunks
 *
 * The last chunk is the method selector. Path bits are OP_0 (left) / OP_1 (right), least
 * significant first, so the slot index is their little-endian value.
 */
import { Script } from '@bsv/sdk';
import { DEPTH } from './merkleLedger';

/** One reconstructed pool operation, addressed by slot. */
export interface MerkleOp {
  ownerPkh: string; // 20-byte hash160, lowercase hex
  slotIndex: number; // which holder slot the spend rewrote
  delta: bigint; // +credit on buy, −debit on sell
  isNew: boolean; // true when the spend APPENDED this slot
}

interface Chunk { op: number; data?: number[] }

const SELECTOR_BUY = 0; // OP_0
const SELECTOR_SELL = 81; // OP_1
// SELECTOR_GRADUATE = 82 (OP_2) — terminal, carries no ledger op.

// chunk offsets, fixed by the compiled ABI
const BUY_PATH_AT = 1;
const BUY_ISNEW_AT = 1 + DEPTH * 2; // 33
const BUY_DELTA_AT = BUY_ISNEW_AT + 2; // 35
const BUY_CHUNKS = BUY_ISNEW_AT + 6; // 39
const SELL_PATH_AT = 3;
const SELL_AMOUNT_AT = 3 + DEPTH * 2 + 1; // 36
const SELL_CHUNKS = SELL_AMOUNT_AT + 4; // 40

/** Read a non-negative Script integer (minimal push, OP_0, or OP_1..OP_16). */
function readUint(c: Chunk): bigint {
  if (c.data && c.data.length > 0) {
    let v = 0n;
    for (let i = c.data.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(c.data[i] & 0xff);
    return v;
  }
  if (c.op === 0) return 0n;
  if (c.op >= 81 && c.op <= 96) return BigInt(c.op - 80);
  throw new Error(`merkleLedgerReconstruct: cannot read integer from opcode ${c.op}`);
}

/** A Script boolean: OP_0 is false, OP_1 is true. Anything else is not a flag we wrote. */
function readBool(c: Chunk): boolean {
  if (c.op === 0 && !(c.data && c.data.length)) return false;
  if (c.op === 81) return true;
  throw new Error(`merkleLedgerReconstruct: opcode ${c.op} is not a boolean`);
}

/** Slot index from the path bits, least-significant bit first. */
function readPath(chunks: Chunk[], at: number): number {
  let idx = 0;
  for (let h = 0; h < DEPTH; h++) if (readBool(chunks[at + h])) idx |= 1 << h;
  return idx;
}

const toHex = (data?: number[]): string =>
  data ? data.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('') : '';

/**
 * Parse one spent MerkleLedgerPool input into the operation it performed. Returns null for a
 * graduation, or for anything that is not a buy/sell unlock.
 */
export function parseMerkleOp(unlockingScriptHex: string): MerkleOp | null {
  let chunks: Chunk[];
  try {
    chunks = Script.fromHex(unlockingScriptHex).chunks as unknown as Chunk[];
  } catch {
    return null;
  }
  const selector = chunks.length ? chunks[chunks.length - 1].op : -1;
  const ownerPkh = toHex(chunks[0]?.data);

  try {
    if (selector === SELECTOR_BUY && chunks.length === BUY_CHUNKS && ownerPkh.length === 40) {
      return {
        ownerPkh,
        slotIndex: readPath(chunks, BUY_PATH_AT),
        delta: readUint(chunks[BUY_DELTA_AT]),
        isNew: readBool(chunks[BUY_ISNEW_AT]),
      };
    }
    if (selector === SELECTOR_SELL && chunks.length === SELL_CHUNKS && ownerPkh.length === 40) {
      return {
        ownerPkh,
        slotIndex: readPath(chunks, SELL_PATH_AT),
        delta: -readUint(chunks[SELL_AMOUNT_AT]),
        isNew: false,
      };
    }
  } catch {
    return null; // malformed for this ABI
  }
  return null;
}

/** Parse an ordered genesis→tip sequence of pool-input unlocks into the op history. */
export function reconstructMerkleHistory(unlockingScriptHexes: string[]): MerkleOp[] {
  const ops: MerkleOp[] = [];
  for (const hex of unlockingScriptHexes) {
    const op = parseMerkleOp(hex);
    if (op) ops.push(op);
  }
  return ops;
}
