import 'server-only';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-only bridge to the MerkleLedgerPool state service (ADR-030). Same shape as
 * `ledger-service.ts`: scrypt-ts is never bundled into Next, so the compiled CLI is invoked as a
 * child process (JSON in/out) and BigInts cross as decimal strings. Build it first:
 * `pnpm --filter @launchpad/curve build:service`.
 *
 * THE IMPORTANT DIFFERENCE FROM ADR-027. There, the recorded Orders WERE the pool's source of
 * truth: the state service had to be handed the whole op history from the database on every spend,
 * so the operator's DB was authoritative and a divergence between it and the chain was unrecoverable.
 * Here `resolveMerklePool` reads the pool straight from the blockchain, so the app stores only what
 * is public and immutable — the genesis outpoint and the terms — and every balance, the reserve and
 * the live outpoint come back from chain. The DB becomes a cache, and a wrong cache is a stale view
 * rather than a lost ledger.
 */
const CLI_REL = path.join('packages', 'curve', 'service', 'dist', 'service', 'cli.js');
let cachedCli: string | null = null;
function cliPath(): string {
  if (cachedCli) return cachedCli;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, CLI_REL);
    if (fs.existsSync(candidate)) return (cachedCli = candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('merkle ledger service CLI not found — run: pnpm --filter @launchpad/curve build:service');
}

function run<T>(action: string, input: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // resolve walks the whole pool chain over the network, so allow a generous timeout
    execFile('node', [cliPath(), action, JSON.stringify(input)], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`merkle ledger service (${action}) failed: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout) as T); }
      catch { reject(new Error(`merkle ledger service (${action}) bad output: ${stdout.slice(0, 200)}`)); }
    });
  });
}

/** The pool's immutable, public terms — everything needed to verify it, and all the app must store. */
export interface MerkleTerms { k: string; supply: string; payoutPkh: string }

/** A slot-addressed op as it happened on chain. Slots are RECORDED, never re-derived. */
export interface MerkleSlotOp { ownerPkh: string; slotIndex: number; delta: string; isNew: boolean }

export interface MerklePoolState {
  txid: string;
  vout: number;
  scriptHex: string;
  reserveSats: number;
  sold: string;
  holderCount: number;
  graduated: boolean;
  hops: number;
  rootHex: string;
  balances: Record<string, string>;
  slots: { index: number; ownerPkh: string; balance: string }[];
  history: MerkleSlotOp[];
}

/** The genesis script to deploy to open a pool with these terms. */
export function merkleGenesisScript(input: MerkleTerms): Promise<{ scriptHex: string }> {
  return run('merkle-genesis', input);
}

/**
 * Resolve the pool from the BLOCKCHAIN — no database involved. Returns `{ error }` rather than
 * throwing when the pool cannot be read, so a UI can show a stale-but-honest state instead of a
 * crash. This is the call that makes the operator's database non-authoritative.
 */
export function resolveMerklePool(input: MerkleTerms & { genesisTxid: string; genesisVout?: number }): Promise<MerklePoolState | { error: string }> {
  return run('merkle-resolve', input);
}

/** BUY: the pool-input unlock (ANYONECANPAY|SINGLE — the caller adds their own payment input). */
export function buildMerkleBuy(input: MerkleTerms & {
  history: MerkleSlotOp[]; ownerPkh: string; delta: string;
  poolTxid: string; poolVout: number; reserveBefore: number; newReserve: number;
}): Promise<{ unlockingHex: string; sourceLockHex: string; nextLockingHex: string; cost: string }> {
  return run('merkle-buy', input);
}

/** SELL step 1: the digest the holder's own wallet signs. No operator signature exists here. */
export function merkleSellDigest(input: MerkleTerms & {
  history: MerkleSlotOp[]; ownerPkh: string; amount: string;
  poolTxid: string; poolVout: number; reserveBefore: number; payoutScriptHex: string;
}): Promise<{ digestHex: string; sourceLockHex: string; nextLockingHex: string; refund: string; reserveAfter: number }> {
  return run('merkle-sell-digest', input);
}

/** SELL step 2: build the unlock from the holder's DER signature. */
export function merkleSellUnlock(input: MerkleTerms & {
  history: MerkleSlotOp[]; ownerPkh: string; ownerPubHex: string; amount: string;
  poolTxid: string; poolVout: number; reserveBefore: number; payoutScriptHex: string; sigDerHex: string;
}): Promise<{ unlockingHex: string; sourceLockHex: string; nextLockingHex: string; refund: string; reserveAfter: number }> {
  return run('merkle-sell-unlock', input);
}

/** GRADUATION (terminal, permissionless): release the reserve to the payout fixed at deploy. */
export function merkleGraduate(input: MerkleTerms & {
  history: MerkleSlotOp[]; poolTxid: string; poolVout: number; reserveBefore: number;
}): Promise<{ unlockingHex: string; sourceLockHex: string; payoutScriptHex: string }> {
  return run('merkle-graduate', input);
}
