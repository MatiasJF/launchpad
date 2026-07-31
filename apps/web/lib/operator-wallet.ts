import 'server-only';

/**
 * The OPERATOR key (ADR-028, Option B). A single server-held key that (1) co-signs
 * the reserve covenant's sell branch — the anti-forgery gate — and (2) owns the un-sold
 * STAS inventory (the vault). No wallet-toolbox, no TAAL: UTXO lookups + broadcasts go
 * through WhatsOnChain like everywhere else in this app. The key lives ONLY in
 * apps/web/.env as OPERATOR_KEY (gitignored, mode 600); this module reads it to sign
 * and never logs or returns it. (Generate it with `pnpm --filter @launchpad/web
 * operator:setup`.)
 */

async function loadBsv(): Promise<any> {
  const mod: any = await import('bsv');
  return mod.default ?? mod;
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
  let sig = bsv.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p);
  const N = bsv.crypto.Point.getN();
  if (sig.s.gt(N.div(new bsv.crypto.BN(2)))) sig.s = N.sub(sig.s); // enforce low-S
  return sig.toDER().toString('hex');
}
