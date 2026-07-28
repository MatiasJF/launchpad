/** A BRC-100 identity pubkey is a 33-byte compressed public key (hex). */
export function isIdentityPubkey(s: string): boolean {
  return /^0[23][0-9a-fA-F]{64}$/.test(s);
}
