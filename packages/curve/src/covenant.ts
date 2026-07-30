/**
 * covenant.ts — assemble a spend of the compiled OP_PUSH_TX Counter covenant
 * using @bsv/sdk (our production runtime), and verify it with the SDK's own
 * Script interpreter. No scrypt-ts at runtime: the contract is compiled to hex
 * ahead of time (see README / `artifacts/`), and here we only push the BIP-143
 * preimage as the unlocking script — exactly the pattern the bonding-curve AMM
 * will use, minus the curve math.
 *
 * This is the Phase-0 spike (ADR-026). It proves the loop end-to-end offline:
 *   compiled covenant hex -> @bsv/sdk output -> preimage-unlock -> valid spend.
 */
import { Spend, Script, UnlockingScript, LockingScript, TransactionSignature, Transaction } from '@bsv/sdk';

/** sighash the Counter covenant checks: ANYONECANPAY | SINGLE | FORKID (0xc3). */
export const COUNTER_SCOPE =
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID |
  TransactionSignature.SIGHASH_SINGLE;

export interface CovenantSpendArgs {
  /** Locking script of the covenant UTXO being spent (its current state). */
  sourceLockHex: string;
  /** Locking script the successor output must re-lock to (next state). */
  nextLockHex: string;
  /** Satoshi balance carried through (SINGLE: input value == output value here). */
  satoshis: number;
  /** Source outpoint — dummy is fine for offline interpreter checks. */
  sourceTXID?: string;
  sourceOutputIndex?: number;
  transactionVersion?: number;
  inputSequence?: number;
  lockTime?: number;
}

/** Build the single-push unlocking script for a `checkPreimage`-style covenant. */
function pushData(bytes: number[]): UnlockingScript {
  const L = bytes.length;
  let prefix: number[];
  if (L <= 75) prefix = [L];
  else if (L <= 255) prefix = [0x4c, L];
  else prefix = [0x4d, L & 0xff, (L >> 8) & 0xff];
  return UnlockingScript.fromHex(Buffer.from([...prefix, ...bytes]).toString('hex'));
}

export interface CovenantSpend {
  /** BIP-143 preimage the covenant verifies (also the unlocking payload). */
  preimage: number[];
  /** The assembled unlocking script (a single push of the preimage). */
  unlockingScript: UnlockingScript;
  /** The source (covenant) locking script. */
  lockingScript: LockingScript;
  /** The successor output the covenant enforces. */
  outputs: Array<{ satoshis: number; lockingScript: LockingScript }>;
}

/** Assemble the preimage + unlocking script for a covenant state transition. */
export function buildCovenantSpend(args: CovenantSpendArgs): CovenantSpend {
  const {
    sourceLockHex,
    nextLockHex,
    satoshis,
    sourceTXID = 'a'.repeat(64),
    sourceOutputIndex = 0,
    transactionVersion = 1,
    inputSequence = 0xffffffff,
    lockTime = 0,
  } = args;

  const lockingScript = LockingScript.fromHex(sourceLockHex);
  const outputs = [{ satoshis, lockingScript: LockingScript.fromHex(nextLockHex) }];

  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex,
    sourceSatoshis: satoshis,
    transactionVersion,
    otherInputs: [],
    outputs,
    inputIndex: 0,
    subscript: lockingScript as unknown as Script,
    inputSequence,
    lockTime,
    scope: COUNTER_SCOPE,
  } as Parameters<typeof TransactionSignature.format>[0]);

  return { preimage, unlockingScript: pushData(preimage), lockingScript, outputs };
}

/** Run the assembled spend through @bsv/sdk's Script interpreter. */
export function validateCovenantSpend(args: CovenantSpendArgs): { ok: boolean; error?: string } {
  const {
    sourceTXID = 'a'.repeat(64),
    sourceOutputIndex = 0,
    transactionVersion = 1,
    inputSequence = 0xffffffff,
    lockTime = 0,
    satoshis,
  } = args;
  const { unlockingScript, lockingScript, outputs } = buildCovenantSpend(args);

  const spend = new Spend({
    sourceTXID,
    sourceOutputIndex,
    sourceSatoshis: satoshis,
    lockingScript,
    transactionVersion,
    otherInputs: [],
    outputs,
    inputIndex: 0,
    unlockingScript,
    inputSequence,
    lockTime,
  } as unknown as ConstructorParameters<typeof Spend>[0]);

  try {
    return { ok: spend.validate() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Validate a covenant input of an ALREADY-ASSEMBLED transaction through
 * @bsv/sdk's Script interpreter. Unlike `validateCovenantSpend` (which builds an
 * idealized spend from scratch), this parses the real broadcastable tx and checks
 * the exact input we're about to send — the true pre-broadcast guard. Reads the
 * real outpoint, version, sequences and outputs from the tx itself, so it can't
 * disagree with the bytes on the wire.
 */
export function validateAssembledCovenantInput(
  rawTxHex: string,
  covenant: { scriptHex: string; satoshis: number },
  inputIndex = 0,
): { ok: boolean; error?: string } {
  try {
    const tx = Transaction.fromHex(rawTxHex);
    const input = tx.inputs[inputIndex];
    if (!input) return { ok: false, error: `no input at index ${inputIndex}` };

    const otherInputs = tx.inputs
      .filter((_, i) => i !== inputIndex)
      .map((inp) => ({
        sourceTXID: inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? '',
        sourceOutputIndex: inp.sourceOutputIndex,
        sequence: inp.sequence ?? 0xffffffff,
      }));
    const outputs = tx.outputs.map((o) => ({ satoshis: o.satoshis, lockingScript: o.lockingScript }));

    const spend = new Spend({
      sourceTXID: input.sourceTXID ?? '',
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: covenant.satoshis,
      lockingScript: LockingScript.fromHex(covenant.scriptHex),
      transactionVersion: tx.version,
      otherInputs,
      outputs,
      inputIndex,
      unlockingScript: input.unlockingScript as unknown as UnlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    } as unknown as ConstructorParameters<typeof Spend>[0]);

    return { ok: spend.validate() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
