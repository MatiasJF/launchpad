import 'server-only';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-only bridge to the StasCurvePool state service (ADR-028, Option B). Only the
 * GENESIS reserve-covenant script needs scrypt-ts (it bakes in k / supply / operatorPkh);
 * every trade successor is derived by cheap byte-patching, so this bridge is used ONLY at
 * deploy. Like ledger-service.ts we invoke the compiled CLI as a child process (JSON in/out)
 * so scrypt-ts is never bundled into Next. Build it first: `pnpm --filter @launchpad/curve
 * build:service`. BigInts cross as decimal strings.
 *
 * Resolve the CLI by walking up from the working dir to the monorepo root (Next's server
 * bundle mangles require.resolve, so we can't rely on it). A clear error is thrown if the
 * service hasn't been built.
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
  throw new Error('stas service CLI not found — run: pnpm --filter @launchpad/curve build:service');
}

function run<T>(action: string, input: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    execFile('node', [cliPath(), action, JSON.stringify(input)], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`stas service (${action}) failed: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout) as T); }
      catch { reject(new Error(`stas service (${action}) bad output: ${stdout.slice(0, 200)}`)); }
    });
  });
}

/**
 * The genesis reserve-covenant locking script to deploy (sold=0), baking in k / supply /
 * operatorPkh. BigInts cross as decimal strings. Returns the script hex.
 */
export async function stasGenesisScript(k: bigint, supply: bigint, operatorPkh: string): Promise<string> {
  const { scriptHex } = await run<{ scriptHex: string }>('stas-genesis', {
    k: k.toString(),
    supply: supply.toString(),
    operatorPkh,
  });
  return scriptHex;
}
