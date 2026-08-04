/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @deprecated ADR-028 (revised, flat-key): NO LONGER on the operator TRADE path. The
 * per-buy delivery + per-sell refund fees now come from the operator's flat-key BASE
 * P2PKH UTXOs via WhatsOnChain (see settle/operatorBaseFunding.ts + settle-actions'
 * getOperatorBaseUtxos/broadcastBeefChain). Reason: this toolbox custody's remote
 * storage rejected every `createAction` ("merged Beef failed validation") once the
 * operator held a chain of unconfirmed txs (a delivery per buy, a refund per sell). This
 * module is kept ONLY so the e2e harness can play the NON-operator wallet roles (admin
 * mint funding, buyer payment, seller STAS return) and for the ops balance script. Do
 * NOT reintroduce it to the delivery/refund fee path.
 *
 * operator-toolbox.ts — the operator's CUSTODY + BROADCAST layer (ADR-028, revised).
 *
 * The operator's on-chain sats/STAS live in a `@bsv/wallet-toolbox` wallet (free,
 * open-source; its broadcaster is auto-configured by `Services` on init — no API key).
 * We use the SAME storage URL + chain that `npx fund-metanet` uses, so the operator
 * wallet sees exactly the coins fund-metanet deposits (fund-metanet parks them at a
 * BRC-42-derived address inside this storage wallet's basket, not at the key's base
 * P2PKH address — so we track UTXOs through the toolbox, not a WoC address lookup).
 *
 * This module is PURE (no `server-only`, no env read) so the ops balance script can
 * reuse the exact same construction. The raw covenant co-sign lives elsewhere
 * (operator-wallet.ts) — it only needs the flat key, not this wallet.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk';
import { Wallet, WalletStorageManager, WalletSigner, Services, StorageClient } from '@bsv/wallet-toolbox';

/** Storage provider fund-metanet defaults to — must match so we see its deposits. */
export const OPERATOR_STORAGE_URL = 'https://store-us-1.bsvb.tech';
export const OPERATOR_CHAIN = 'main' as const;

/** Build (and make available) an operator toolbox Wallet from a 64-char hex key. */
export async function makeOperatorWallet(
  keyHex: string,
  opts: { chain?: 'main' | 'test'; storageURL?: string } = {},
): Promise<any> {
  const chain = opts.chain ?? OPERATOR_CHAIN;
  const storageURL = opts.storageURL ?? OPERATOR_STORAGE_URL;
  const keyDeriver = new KeyDeriver(new PrivateKey(keyHex, 'hex'));
  const storageManager = new WalletStorageManager(keyDeriver.identityKey);
  const signer = new WalletSigner(chain as any, keyDeriver as any, storageManager);
  const services = new Services(chain as any);
  const wallet = new Wallet(signer as any, services as any);
  const client = new StorageClient(wallet as any, storageURL);
  await client.makeAvailable();
  await storageManager.addWalletStorageProvider(client as any);
  return wallet;
}

/** Total spendable satoshis in the wallet's default basket. */
export async function walletBalanceSats(wallet: any): Promise<number> {
  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 }, 'launchpad');
  return (outputs ?? []).reduce((sum: number, o: any) => sum + Number(o.satoshis ?? 0), 0);
}
