// Operator balance check. Reads OPERATOR_KEY from apps/web/.env, initializes the
// operator's wallet-toolbox wallet against the SAME storage as `npx fund-metanet`
// (store-us-1.bsvb.tech, main), and prints the spendable satoshi balance. Use it to
// confirm a fund-metanet deposit landed. Prints only public info — never the key.
// Run:  pnpm --filter @launchpad/web operator:balance
import fs from 'node:fs';
import { KeyDeriver, PrivateKey } from '@bsv/sdk';
import { Wallet, WalletStorageManager, WalletSigner, Services, StorageClient } from '@bsv/wallet-toolbox';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // match fund-metanet's storage handshake

const ENV_PATH = new URL('../.env', import.meta.url);
const txt = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
const m = txt.match(/^OPERATOR_KEY=(.+)$/m);
const keyHex = (m ? m[1] : '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  console.error('❌ OPERATOR_KEY missing or not 64-char hex in apps/web/.env — run operator:setup');
  process.exit(1);
}

const CHAIN = 'main';
const STORAGE_URL = 'https://store-us-1.bsvb.tech';

const keyDeriver = new KeyDeriver(new PrivateKey(keyHex, 'hex'));
const storageManager = new WalletStorageManager(keyDeriver.identityKey);
const signer = new WalletSigner(CHAIN, keyDeriver, storageManager);
const services = new Services(CHAIN);
const wallet = new Wallet(signer, services);
const client = new StorageClient(wallet, STORAGE_URL);
await client.makeAvailable();
await storageManager.addWalletStorageProvider(client);

const { outputs, totalOutputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 }, 'launchpad');
const sats = (outputs ?? []).reduce((s, o) => s + Number(o.satoshis ?? 0), 0);

console.log('\n--- OPERATOR WALLET (toolbox / store-us-1.bsvb.tech, main) ---');
console.log('identity key :', keyDeriver.identityKey);
console.log('outputs      :', totalOutputs ?? (outputs ?? []).length);
console.log('BALANCE (sats):', sats);
process.exit(0);
