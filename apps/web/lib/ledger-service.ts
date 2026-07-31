import 'server-only';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-only bridge to the LedgerPool state service (ADR-027). The service uses
 * scrypt-ts, which we do NOT bundle into Next — instead we invoke its compiled CLI
 * as a child process (JSON in/out). Build it first: `pnpm --filter @launchpad/curve
 * build:service`. BigInts cross as decimal strings.
 *
 * Resolve the CLI by walking up from the working dir to the monorepo root (Next's
 * server bundle mangles require.resolve, so we can't rely on it). A clear error is
 * thrown if the service hasn't been built.
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
  throw new Error('ledger service CLI not found — run: pnpm --filter @launchpad/curve build:service');
}

function run<T>(action: string, input: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    execFile('node', [cliPath(), action, JSON.stringify(input)], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ledger service (${action}) failed: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout) as T); }
      catch { reject(new Error(`ledger service (${action}) bad output: ${stdout.slice(0, 200)}`)); }
    });
  });
}

/** One prior pool op (buy delta > 0, sell delta < 0), ordered oldest-first. */
export interface LedgerOp { ownerPkh: string; delta: string }

/** The genesis pool script to deploy (empty history). */
export function ledgerGenesisScript(input: { k: string; supply: string; payoutPkh: string }): Promise<{ scriptHex: string }> {
  return run('genesis', input);
}

/** BUY: full pool-input unlock (ANYONECANPAY|SINGLE — caller adds the payment input). */
export function buildLedgerBuy(input: {
  k: string; supply: string; payoutPkh: string; history: LedgerOp[];
  ownerPkh: string; delta: string; poolTxid: string; poolVout: number;
  reserveBefore: number; newReserve: number;
}): Promise<{ unlockingHex: string; sourceLockHex: string; nextLockingHex: string }> {
  return run('buy', input);
}

/** SELL step 1: the digest the holder's wallet signs + successor/payout/refund. */
export function ledgerSellDigest(input: {
  k: string; supply: string; payoutPkh: string; history: LedgerOp[];
  ownerPkh: string; amount: string; poolTxid: string; poolVout: number;
  reserveBefore: number; payoutScriptHex: string;
}): Promise<{ digestHex: string; sourceLockHex: string; nextLockingHex: string; payoutScriptHex: string; refund: string; reserveAfter: number }> {
  return run('sell-digest', input);
}

/** SELL step 2: build the unlock from the holder's DER signature. */
export function ledgerSellUnlock(input: {
  k: string; supply: string; payoutPkh: string; history: LedgerOp[];
  ownerPkh: string; ownerPubHex: string; amount: string; poolTxid: string; poolVout: number;
  reserveBefore: number; payoutScriptHex: string; sigDerHex: string;
}): Promise<{ unlockingHex: string; sourceLockHex: string; nextLockingHex: string; refund: string }> {
  return run('sell-unlock', input);
}

/** GRADUATION (terminal): release the reserve to the committed payout. */
export function ledgerGraduate(input: {
  k: string; supply: string; payoutPkh: string; history: LedgerOp[];
  poolTxid: string; poolVout: number; reserveBefore: number;
}): Promise<{ unlockingHex: string; sourceLockHex: string; payoutScriptHex: string; reserve: number }> {
  return run('graduate', input);
}
