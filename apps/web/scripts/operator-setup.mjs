// One-time operator setup. Ensures apps/web/.env has OPERATOR_KEY (a server signing key),
// generating a fresh one if absent, and prints ONLY public info (address to fund + pkh).
// The private key is written to the gitignored .env and never printed. The key is used
// two ways: raw ECDSA to co-sign the reserve covenant, and as the root of the operator's
// wallet-toolbox custody wallet (fund it with `npx fund-metanet`; check `operator:balance`).
// Run:  pnpm --filter @launchpad/web operator:setup
import bsvMod from 'bsv';
import fs from 'node:fs';
const bsv = bsvMod.default ?? bsvMod;

const ENV_PATH = new URL('../.env', import.meta.url);
const read = () => (fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '');
const parse = (txt) => Object.fromEntries(txt.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

let txt = read();
let env = parse(txt);
let keyHex = env.OPERATOR_KEY;

// migrate an older wallet-toolbox-style .env (DEV_KEYS) → OPERATOR_KEY, keeping the key
if (!keyHex && env.DEV_KEYS) {
  try { const dk = JSON.parse(env.DEV_KEYS); keyHex = dk[env.MY_MAIN_IDENTITY] ?? Object.values(dk)[0]; } catch {}
}
if (!keyHex) keyHex = bsv.PrivateKey.fromRandom().toString();

if (!/OPERATOR_KEY=/.test(txt)) {
  const header = fs.existsSync(ENV_PATH) ? '' : '# Operator server key — SECRET. Never commit/share. (.env is gitignored.)\n';
  fs.writeFileSync(ENV_PATH, `${txt}${txt && !txt.endsWith('\n') ? '\n' : ''}${header}OPERATOR_KEY=${keyHex}\n`, { mode: 0o600 });
  console.log('Ensured OPERATOR_KEY in apps/web/.env (gitignored).');
} else {
  console.log('apps/web/.env already has OPERATOR_KEY — keeping it.');
}

const pub = bsv.PrivateKey.fromString(keyHex).toPublicKey();
console.log('\n--- OPERATOR (public info only) ---');
console.log('pubkey (baked into pools):', pub.toString());
console.log('pkh                      :', bsv.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex'));
console.log('\nFund the operator via wallet-toolbox (NOT a plain send to a base address):');
console.log('  npx fund-metanet --chain main --private-key <OPERATOR_KEY hex> --satoshis 10000');
console.log('Then verify:  pnpm --filter @launchpad/web operator:balance');
process.exit(0);
