/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { makeOperatorWallet, walletBalanceSats } from './operator-toolbox';

/**
 * The OPERATOR key (ADR-028, revised). A single server-held key with two roles:
 *   (1) CO-SIGN the reserve covenant's sell branch — the anti-forgery gate. This is a
 *       raw ECDSA signature over the sighash from the flat key whose hash160 is baked
 *       into the covenant as `operatorPkh`; it needs nothing but the key (below).
 *   (2) CUSTODY — hold the operator's sats/STAS + pay sell-tx fees + broadcast. This
 *       runs on `@bsv/wallet-toolbox` (see operator-toolbox.ts): free, open-source, the
 *       broadcaster auto-configures on init (no API key), and it shares fund-metanet's
 *       storage so `npx fund-metanet` funds it directly.
 * The key lives ONLY in apps/web/.env as OPERATOR_KEY (gitignored, mode 600); this
 * module reads it to sign and never logs or returns it. (Generate it with
 * `pnpm --filter @launchpad/web operator:setup`.)
 */

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

function keyHex(): string {
  const raw = process.env.OPERATOR_KEY?.trim();
  if (!raw) throw new Error('OPERATOR_KEY not set — run `pnpm --filter @launchpad/web operator:setup`');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('OPERATOR_KEY must be 64-char hex');
  return raw;
}

// The toolbox wallet is expensive to init (network handshake) — memoize per process.
let walletPromise: Promise<any> | null = null;

/**
 * @deprecated ADR-028 (revised): NOT on the trade path anymore. The operator's delivery
 * + refund fees come from flat-key BASE-address UTXOs via WhatsOnChain (see
 * settle/operatorBaseFunding.ts). This toolbox wallet corrupted under unconfirmed-chain
 * trade load. Kept only for legacy ops tooling; do not use it to fund trades.
 * The operator's custody wallet (toolbox-backed). Lazily initialized + memoized.
 */
export async function getOperatorWallet(): Promise<any> {
  if (!walletPromise) walletPromise = makeOperatorWallet(keyHex());
  return walletPromise;
}

/** @deprecated see getOperatorWallet. Total sats in the legacy toolbox custody wallet. */
export async function operatorBalance(): Promise<number> {
  return walletBalanceSats(await getOperatorWallet());
}

async function priv(): Promise<any> {
  const raw = process.env.OPERATOR_KEY;
  if (!raw) throw new Error('OPERATOR_KEY not set — run `pnpm --filter @launchpad/web operator:setup`');
  const bsv = await loadBsv();
  // accept WIF or 64-char hex
  return /^[0-9a-fA-F]{64}$/.test(raw.trim()) ? bsv.PrivateKey.fromString(raw.trim()) : bsv.PrivateKey.fromWIF(raw.trim());
}

/** The operator's public key + hash160 (baked into pools at deploy) + P2PKH address (the vault). */
export async function getOperator(): Promise<{ pubHex: string; pkh: string; address: string }> {
  const bsv = await loadBsv();
  const p = await priv();
  const pub = p.toPublicKey();
  return {
    pubHex: pub.toString(),
    pkh: bsv.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex'),
    address: pub.toAddress().toString(),
  };
}

/** Co-sign a sell: sign sha256sha256(preimage) with the operator key → DER sig hex,
 *  forced low-S (BSV consensus). The caller appends the sighash-type byte. */
export async function operatorSignDigest(digestHex: string): Promise<string> {
  const bsv = await loadBsv();
  const p = await priv();
  const sig = bsv.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p);
  const N = bsv.crypto.Point.getN();
  if (sig.s.gt(N.div(new bsv.crypto.BN(2)))) sig.s = N.sub(sig.s); // enforce low-S
  return sig.toDER().toString('hex');
}
