// Prints the operator wallet's curve-gate address (fund this) + pkh (baked into pools).
// Run after configuring apps/web/.env:  pnpm --filter @launchpad/web operator:info
import { Setup } from '@bsv/wallet-toolbox';
import { PublicKey } from '@bsv/sdk';

const env = Setup.getEnv('main');
const setup = await Setup.createWalletSQLite({ env, filePath: process.env.OPERATOR_WALLET_DB ?? './server-wallet.sqlite', databaseName: 'operator-wallet' });
const derivation = { protocolID: [2, 'a1b2c3d4e5f6'], keyID: 'curve-operator', counterparty: 'anyone', forSelf: true };
const { publicKey } = await setup.wallet.getPublicKey(derivation);
const pub = PublicKey.fromString(publicKey);
console.log('operator identity :', setup.identityKey);
console.log('curve-gate pubkey :', publicKey);
console.log('curve-gate pkh    :', Buffer.from(pub.toHash()).toString('hex'));
console.log('FUND THIS ADDRESS :', pub.toAddress().toString());
process.exit(0);
