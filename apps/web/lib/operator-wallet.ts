/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { makeOperatorWallet, walletBalanceSats } from './operator-toolbox';

/**
 * The OPERATOR key (ADR-028/029) — the reserve-security boundary. It (1) CO-SIGNS the
 * covenant sell branch (anti-forgery gate), signs the STAS vault delivery, and signs the
 * base fee inputs — all through `operatorSignDigest(digestHex)`; and (2) provides the
 * operator public key / pkh / address (`getOperator`), baked into pools at deploy.
 *
 * SIGNER BACKENDS — select with the `OPERATOR_SIGNER` env var:
 *   • 'local' (default): the private key lives in apps/web/.env as OPERATOR_KEY and this
 *     module signs with it (raw ECDSA + low-S). Fine for dev/testing; the key is on the box.
 *   • 'remote' (a.k.a. 'kms'/'hsm'): the private key lives in an HSM/KMS and NEVER enters
 *     the app. This module POSTs the 32-byte digest to `OPERATOR_SIGNER_URL` (bearer
 *     `OPERATOR_SIGNER_TOKEN`); the remote signer signs the secp256k1 DIGEST with the HSM
 *     key and returns a DER signature. `getOperator()` then reads the PUBLIC `OPERATOR_PUBKEY`
 *     env — so no private key is present anywhere in the app. Back the signer with AWS KMS
 *     (ECC_SECG_P256K1), GCP KMS, a YubiHSM, or an air-gapped service.
 *     Contract + provider recipes: docs/OPERATOR-KEY-CUSTODY.md.
 *
 * HONEST SCOPE: the HSM boundary protects the KEY MATERIAL (it can't be exfiltrated from
 * the app/.env). It does NOT by itself stop a compromised APP from asking the signer to
 * sign a malicious digest — for that, give the remote signer its own policy (rate/amount
 * limits, or validate the tx it signs). Per ADR-029 the operator co-sign path is
 * reserve-critical; production MUST run `OPERATOR_SIGNER=remote`.
 */

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * The operator's public key + hash160 (baked into pools at deploy) + P2PKH address (the vault).
 * In REMOTE/HSM mode the private key isn't present, so the (public) pubkey comes from the
 * OPERATOR_PUBKEY env var; in LOCAL mode it is derived from OPERATOR_KEY.
 */
export async function getOperator(): Promise<{ pubHex: string; pkh: string; address: string }> {
  const bsv = await loadBsv();
  const pubEnv = process.env.OPERATOR_PUBKEY?.trim();
  const pub =
    pubEnv && /^0[23][0-9a-fA-F]{64}$/.test(pubEnv)
      ? bsv.PublicKey.fromString(pubEnv) // remote/HSM: public key from env (no private key needed)
      : (await priv()).toPublicKey(); // local: derive from OPERATOR_KEY
  return {
    pubHex: pub.toString(),
    pkh: bsv.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex'),
    address: pub.toAddress().toString(),
  };
}

/** Parse a DER sig and force low-S (BSV consensus) — applied to BOTH the local and remote
 *  paths so an HSM that doesn't canonicalize can't produce a non-low-S (mempool-rejected) sig. */
async function canonicalizeLowS(derHex: string): Promise<string> {
  const bsv = await loadBsv();
  const sig = bsv.crypto.Signature.fromDER(Buffer.from(derHex, 'hex'));
  const N = bsv.crypto.Point.getN();
  if (sig.s.gt(N.div(new bsv.crypto.BN(2)))) sig.s = N.sub(sig.s);
  return sig.toDER().toString('hex');
}

/** LOCAL backend: raw ECDSA over the digest with the OPERATOR_KEY private key. */
async function localSignDigest(digestHex: string): Promise<string> {
  const bsv = await loadBsv();
  const p = await priv();
  return bsv.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p).toDER().toString('hex');
}

/**
 * REMOTE backend: POST the 32-byte digest to an HSM/KMS-backed signer, retried on transient
 * failure. Contract — request `{ digestHex, curve: 'secp256k1' }` (the digest is signed
 * DIRECTLY, i.e. raw ECDSA, no extra hashing — AWS KMS: MessageType=DIGEST,
 * SigningAlgorithm=ECDSA_SHA_256); response `{ signatureDer: <hex> }` (also accepts `der`
 * or `signature`). The signer must own the key whose pubkey is OPERATOR_PUBKEY.
 */
async function remoteSignDigest(digestHex: string): Promise<string> {
  const url = process.env.OPERATOR_SIGNER_URL;
  if (!url) throw new Error('OPERATOR_SIGNER=remote but OPERATOR_SIGNER_URL is not set');
  const token = process.env.OPERATOR_SIGNER_TOKEN ?? '';
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ digestHex, curve: 'secp256k1' }),
        cache: 'no-store',
      });
      if (!res.ok) { lastErr = `signer HTTP ${res.status}`; await sleep(500 * (attempt + 1)); continue; }
      const body: any = await res.json().catch(() => ({}));
      const der = String(body?.signatureDer ?? body?.der ?? body?.signature ?? '');
      if (!/^[0-9a-fA-F]{8,}$/.test(der)) throw new Error(`bad signer response: ${JSON.stringify(body).slice(0, 120)}`);
      return der;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`remote operator signer failed after retries: ${lastErr}`);
}

/** Co-sign: sign the 32-byte `digestHex` (sha256sha256(preimage) for the covenant, or a
 *  P2PKH sighash) → DER sig hex, forced low-S. Dispatches to the configured backend
 *  (OPERATOR_SIGNER: 'local' default, or 'remote'/'kms'/'hsm'). The caller appends the
 *  sighash-type byte. */
export async function operatorSignDigest(digestHex: string): Promise<string> {
  const mode = (process.env.OPERATOR_SIGNER ?? 'local').toLowerCase();
  const der =
    mode === 'remote' || mode === 'kms' || mode === 'hsm'
      ? await remoteSignDigest(digestHex)
      : await localSignDigest(digestHex);
  return canonicalizeLowS(der);
}
