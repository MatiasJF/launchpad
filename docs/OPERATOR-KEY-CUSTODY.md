# Operator key custody (HSM / KMS)

The operator co-sign key is the **reserve-security boundary** (ADR-029): it co-signs the
covenant sell branch, signs the STAS vault delivery, and signs the operator base fee inputs.
A leaked operator key can drain the whole reserve. In **dev/testing** the key lives in
`apps/web/.env` as `OPERATOR_KEY`; in **production it MUST live in an HSM/KMS** and never
enter the app.

`apps/web/lib/operator-wallet.ts` supports two backends, selected by `OPERATOR_SIGNER`:

| `OPERATOR_SIGNER` | Key location | Use |
|---|---|---|
| `local` (default) | `OPERATOR_KEY` in `.env` | dev / testing only |
| `remote` (`kms`/`hsm`) | HSM/KMS behind a signer endpoint | production |

Everything routes through `operatorSignDigest(digestHex)` and `getOperator()`, so switching
backends changes **no** call sites. Low-S canonicalization is applied to **both** backends'
output (an HSM that doesn't canonicalize can't produce a mempool-rejected non-low-S sig).

## Remote signer — env

```
OPERATOR_SIGNER=remote
OPERATOR_SIGNER_URL=https://signer.internal/operator/sign   # your HSM-backed endpoint
OPERATOR_SIGNER_TOKEN=<bearer token the app presents>
OPERATOR_PUBKEY=<33-byte compressed pubkey hex of the HSM key>   # public — safe in env
# OPERATOR_KEY is NOT set in production
```

`getOperator()` derives the pkh + vault address from `OPERATOR_PUBKEY` (public), so the app
holds **no private key**.

## Remote signer — HTTP contract

The app POSTs the pre-computed 32-byte digest; the signer signs it **directly** (raw ECDSA,
no extra hashing) with the secp256k1 key and returns a DER signature.

```
POST $OPERATOR_SIGNER_URL
Authorization: Bearer $OPERATOR_SIGNER_TOKEN
{ "digestHex": "<64 hex chars>", "curve": "secp256k1" }

200 → { "signatureDer": "<DER sig hex>" }     // also accepts { "der": ... } / { "signature": ... }
```

The digest is `sha256sha256(preimage)` (covenant/STAS) or a P2PKH sighash — already hashed,
so the signer signs the digest as-is. With **AWS KMS** that is `MessageType=DIGEST`,
`SigningAlgorithm=ECDSA_SHA_256`.

## Provider recipes (back the endpoint with one of these)

- **AWS KMS** — key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`. `GetPublicKey` → parse the
  SPKI → compressed pubkey → set `OPERATOR_PUBKEY`. Sign with `MessageType=DIGEST`,
  `SigningAlgorithm=ECDSA_SHA_256`; KMS returns DER (the app forces low-S).
- **GCP Cloud KMS** — EC key `EC_SIGN_SECP256K1_SHA256` (where offered); sign the digest,
  return DER.
- **YubiHSM 2 / hardware HSM** — a secp256k1 key; a thin service calls the HSM's ECDSA sign
  over the digest and returns DER.
- **Air-gapped** — the endpoint can front an offline signer / approval queue; the contract is
  the same (digest in, DER out).

A reference signer is ~30 lines: verify the bearer token, call the HSM/KMS `sign(digest)`,
return `{ signatureDer }`. Keep it a small, isolated, audited service — it is the only thing
that touches the key.

## ⚠️ Migration: the pubkey MUST match deployed pools

Every deployed pool bakes `operatorPkh = hash160(operator pubkey)` into the covenant. If you
move to an HSM key with a **different** pubkey, `getOperator().pkh` will no longer match the
pools' baked `operatorPkh`, and **co-signing every existing pool's sell will fail**. So either:

1. **Import the existing operator key** into the HSM/KMS (pubkey unchanged) — pools keep working; or
2. **Use the new HSM pubkey only for pools deployed after the switch** (old pools keep the old key).

After configuring remote mode, verify `getOperator().pkh` equals the `operatorPkh` baked into
the pool(s) you intend to serve (`CurvePool.operatorPkh`) before trading.

## Honest scope

The HSM boundary protects the **key material** (it can't be exfiltrated from the app/.env). It
does **not** by itself stop a compromised *app* from asking the signer to sign a malicious
digest. For that, give the signer its own **policy** — rate/amount limits, allow-lists, or
(strongest) have it re-derive and validate the transaction it is asked to sign. Per ADR-029 the
operator co-sign path is reserve-critical; treat the signer service as crown-jewel infrastructure.
