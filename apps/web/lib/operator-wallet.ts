import 'server-only';
import { Setup } from '@bsv/wallet-toolbox';
import { PublicKey, type WalletInterface, type WalletProtocol } from '@bsv/sdk';

/**
 * The OPERATOR wallet (ADR-028, Option B). A server-side BSV wallet that (1) co-signs
 * the reserve covenant's sell branch — the anti-forgery gate — and (2) owns the un-sold
 * STAS inventory (the vault). The private key lives in the wallet's own storage / .env
 * (NEVER in this repo, never logged — golden rule 3); our code only calls its BRC-100
 * sign API, exactly like the browser WalletClient.
 *
 * Setup (one-time, out of band):
 *   1) `pnpm --filter @launchpad/web operator:env`  → prints a starter .env (Setup.makeEnv)
 *   2) fill MY_MAIN_IDENTITY + DEV_KEYS + MAIN_TAAL_API_KEY in apps/web/.env (gitignored)
 *   3) `pnpm --filter @launchpad/web operator:info` → prints the operator address to fund
 *   4) send a little BSV to that address (covers fees)
 * The wallet's UTXO ledger lives in server-wallet.sqlite (gitignored).
 */

/** BRC-42 derivation for the operator's curve-gate key. getPublicKey and createSignature
 *  MUST use this identical derivation or the covenant's checkSig fails. */
const OP_PROTOCOL: WalletProtocol = [2, 'a1b2c3d4e5f6'];
const OP_DERIVATION = { protocolID: OP_PROTOCOL, keyID: 'curve-operator', counterparty: 'anyone' as const, forSelf: true };

let cached: Promise<WalletInterface> | null = null;
async function wallet(): Promise<WalletInterface> {
  if (!cached) {
    cached = (async () => {
      const env = Setup.getEnv('main'); // mainnet only (golden rule: no testnet)
      const setup = await Setup.createWalletSQLite({
        env,
        filePath: process.env.OPERATOR_WALLET_DB ?? './server-wallet.sqlite',
        databaseName: 'operator-wallet',
      });
      return setup.wallet as unknown as WalletInterface;
    })();
  }
  return cached;
}

/** The operator's curve-gate public key + its hash160 (baked into covenants at deploy). */
export async function getOperator(): Promise<{ pubHex: string; pkh: string; address: string }> {
  const w = await wallet();
  const { publicKey } = await w.getPublicKey(OP_DERIVATION as never);
  const pub = PublicKey.fromString(publicKey);
  const pkh = Buffer.from(pub.toHash() as number[]).toString('hex');
  const address = pub.toAddress().toString();
  return { pubHex: publicKey, pkh, address };
}

/** Co-sign a sell: sign sha256sha256(preimage) with the operator key → DER sig hex
 *  (no sighash-type byte — the caller appends it). This is the gate signature. */
export async function operatorSignDigest(digestHex: string): Promise<string> {
  const w = await wallet();
  const digest = Array.from(Buffer.from(digestHex, 'hex')) as number[];
  const res = await w.createSignature({ ...OP_DERIVATION, hashToDirectlySign: digest } as never);
  return Buffer.from(res.signature as number[]).toString('hex');
}

/** The underlying wallet (for STAS vault operations: mint-to, release on buy, receive on sell). */
export async function operatorWallet(): Promise<WalletInterface> {
  return wallet();
}
