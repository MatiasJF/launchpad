/**
 * curvePool.ts — assemble and verify a BUY against the LinearCurvePool covenant
 * using @bsv/sdk (runtime; no scrypt-ts). A buy spends the pool UTXO and re-locks
 * to the successor pool (sold+delta) with value >= reserveBefore + cost. The
 * unlocking script pushes the two public args (delta, newReserve) then this tx's
 * BIP-143 preimage — the covenant enforces the curve inequality against them.
 *
 * Curve (must mirror LinearCurvePool.buy exactly):
 *   cost = k · delta · (2·sold + delta + 1) / 2       (exact; the /2 never truncates)
 */
import { Spend, LockingScript, UnlockingScript, TransactionSignature } from '@bsv/sdk';

/** ANYONECANPAY | SINGLE | FORKID (0xc3) — the sighash the covenant checks. */
export const CURVE_SCOPE =
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID |
  TransactionSignature.SIGHASH_SINGLE;

/** Exact integer cost to buy `delta` tokens when `sold` have already been sold. */
export function curveCost(k: bigint, sold: bigint, delta: bigint): bigint {
  return (k * delta * (2n * sold + delta + 1n)) / 2n;
}

/** Minimal little-endian ScriptNum encoding of a non-negative integer. */
function scriptNum(n: bigint): number[] {
  if (n === 0n) return [];
  if (n < 0n) throw new Error('scriptNum: negative not supported here');
  const out: number[] = [];
  let v = n;
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  // if the high bit of the top byte is set, append 0x00 so it stays positive
  if ((out[out.length - 1]! & 0x80) !== 0) out.push(0x00);
  return out;
}

function push(bytes: number[]): number[] {
  const L = bytes.length;
  if (L === 0) return [0x00]; // OP_0 (empty pushdata)
  if (L <= 75) return [L, ...bytes];
  if (L <= 255) return [0x4c, L, ...bytes];
  return [0x4d, L & 0xff, (L >> 8) & 0xff, ...bytes];
}

/**
 * Minimal number push for a public-method int arg. The interpreter enforces
 * MINIMALDATA, so 0 -> OP_0 and 1..16 -> OP_1..OP_16; larger values fall back to
 * a length-prefixed ScriptNum push. Without this, `buy(10, ...)` is rejected as
 * "not minimally-encoded" before the covenant even runs.
 */
function pushInt(n: bigint): number[] {
  if (n === 0n) return [0x00]; // OP_0
  if (n >= 1n && n <= 16n) return [0x50 + Number(n)]; // OP_1 .. OP_16
  return push(scriptNum(n));
}

export interface BuySpendArgs {
  poolLockHex: string; // covenant script at current `sold`
  reserveBefore: number; // covenant UTXO satoshi value
  nextPoolLockHex: string; // covenant script at `sold + delta`
  newReserve: number; // successor pool output value
  delta: bigint; // tokens bought
  sourceTXID?: string;
  sourceOutputIndex?: number;
  transactionVersion?: number;
  inputSequence?: number;
  lockTime?: number;
}

/** Build the unlocking script (delta, newReserve, preimage) for a buy. */
export function buildBuySpend(args: BuySpendArgs): { preimage: number[]; unlockingScript: UnlockingScript } {
  const {
    poolLockHex, reserveBefore, nextPoolLockHex, newReserve, delta,
    sourceTXID = 'a'.repeat(64), sourceOutputIndex = 0,
    transactionVersion = 1, inputSequence = 0xffffffff, lockTime = 0,
  } = args;

  const lockingScript = LockingScript.fromHex(poolLockHex);
  const outputs = [{ satoshis: newReserve, lockingScript: LockingScript.fromHex(nextPoolLockHex) }];

  const preimage = TransactionSignature.format({
    sourceTXID, sourceOutputIndex, sourceSatoshis: reserveBefore,
    transactionVersion, otherInputs: [], outputs, inputIndex: 0,
    subscript: lockingScript, inputSequence, lockTime, scope: CURVE_SCOPE,
  } as Parameters<typeof TransactionSignature.format>[0]);

  // declaration order: buy(delta, newReserve, preimage). Number args use minimal
  // number pushes (OP_N for 0..16); the preimage is a plain data push.
  const unlockingHex = Buffer.from([
    ...pushInt(delta),
    ...pushInt(BigInt(newReserve)),
    ...push(preimage),
  ]).toString('hex');

  return { preimage, unlockingScript: UnlockingScript.fromHex(unlockingHex) };
}

/** Assemble a buy and run it through @bsv/sdk's Script interpreter (offline). */
export function validateBuy(args: BuySpendArgs): { ok: boolean; error?: string } {
  const {
    poolLockHex, reserveBefore, nextPoolLockHex, newReserve,
    sourceTXID = 'a'.repeat(64), sourceOutputIndex = 0,
    transactionVersion = 1, inputSequence = 0xffffffff, lockTime = 0,
  } = args;
  const { unlockingScript } = buildBuySpend(args);
  const outputs = [{ satoshis: newReserve, lockingScript: LockingScript.fromHex(nextPoolLockHex) }];

  const spend = new Spend({
    sourceTXID, sourceOutputIndex, sourceSatoshis: reserveBefore,
    lockingScript: LockingScript.fromHex(poolLockHex),
    transactionVersion, otherInputs: [], outputs, inputIndex: 0,
    unlockingScript, inputSequence, lockTime,
  } as unknown as ConstructorParameters<typeof Spend>[0]);

  try {
    return { ok: spend.validate() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
