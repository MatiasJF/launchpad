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

/**
 * Runtime derivation of the pool's SUCCESSOR locking script (scrypt-ts-free).
 *
 * A stateful scrypt-ts contract's locking script is `codePart ++ stateRegion`,
 * where only `stateRegion` changes between states. For LinearCurvePool the sole
 * mutable field is `sold`, serialized as:
 *
 *     6a <flag> <push(scriptNum(sold))> <stateBodyLen : 4-byte LE> 00
 *
 * `codePart` (which bakes in the immutable k / supply) is identical across all
 * successors, so we strip the current script's state region to recover it, then
 * re-emit the region for `newSold` in canonical getStateScript form (flag 0x00 —
 * exactly what the covenant's `buildStateOutput` reconstructs and hashes). Verified
 * byte-for-byte against compiled fixtures in test/curve-script.test.mjs — the pool
 * would brick if this diverged, so it is not derived by hand at call sites.
 */
function stateRegionLen(script: Buffer): number {
  const n = script.length;
  // trailer byte at n-1, the 4-byte LE state-body length at n-5..n-2
  const bodyLen = script.readUInt32LE(n - 5);
  return 1 /* 6a */ + bodyLen + 4 /* LE len */ + 1 /* trailer */;
}

/** Recover the immutable code part (everything before the mutable state region). */
export function poolCodePart(currentScriptHex: string): string {
  const b = Buffer.from(currentScriptHex, 'hex');
  const region = stateRegionLen(b);
  const start = b.length - region;
  if (start < 0 || b[start] !== 0x6a) throw new Error('unexpected pool state layout');
  return b.subarray(0, start).toString('hex');
}

/** Build the successor pool locking script for `newSold` from the current script. */
export function poolScriptForSold(currentScriptHex: string, newSold: bigint): string {
  const codePart = poolCodePart(currentScriptHex);
  const sn = scriptNum(newSold); // minimal LE, sign-padded — matches scrypt @state int
  const body = [0x00, sn.length, ...sn]; // flag 0x00 + push(scriptNum(sold))
  const len = body.length;
  const le4 = [len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff];
  const region = [0x6a, ...body, ...le4, 0x00];
  return codePart + Buffer.from(region).toString('hex');
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
