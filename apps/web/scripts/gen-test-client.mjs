// gen-test-client.mjs — generate (or show) the SEPARATE client test wallet.
//
// The e2e harness plays the CLIENT roles (admin deploy+mint, buyer payment, seller STAS
// return) — distinct from the OPERATOR (delivery/refund co-sign + reserve/vault). This
// creates a fresh, throwaway flat key `TEST_CLIENT_KEY` in gitignored apps/web/.env so the
// harness can drive a real two-party (client ≠ operator) test. The private key is NEVER
// printed — only the address, so it can be funded. Idempotent: if the key exists, just
// prints its address.
//
// Run:  pnpm --filter @launchpad/web test:client
import fs from 'node:fs';
import { PrivateKey } from '@bsv/sdk';

const ENV_PATH = new URL('../.env', import.meta.url);
let env = '';
try { env = fs.readFileSync(ENV_PATH, 'utf8'); } catch { env = ''; }

const existing = env.match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})$/m)?.[1];
if (existing) {
  const addr = PrivateKey.fromString(existing, 'hex').toPublicKey().toAddress();
  console.log('TEST_CLIENT_KEY already set.');
  console.log('client test address:', addr);
  console.log('(fund this address to run the two-party harness)');
  process.exit(0);
}

const key = PrivateKey.fromRandom();
const addr = key.toPublicKey().toAddress();
const sep = env.length === 0 || env.endsWith('\n') ? '' : '\n';
fs.appendFileSync(ENV_PATH, `${sep}TEST_CLIENT_KEY=${key.toHex()}\n`);
console.log('✅ generated a fresh client test key → apps/web/.env (TEST_CLIENT_KEY, gitignored).');
console.log('client test address:', addr);
console.log('(fund this address; the harness spends it for the buyer/seller/admin roles)');
process.exit(0);
