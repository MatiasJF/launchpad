/**
 * STAS token issuance — non-custodial (ADR-021).
 *
 * Stage 1 (this file): derive the token's wallet keys and build the STAS
 * locking script + a dry-run MINT PLAN (no broadcast). The contract/issue
 * transaction assembly, wallet signing bridge, and broadcast are Stage 2
 * (`buildAndBroadcastMint`).
 *
 * STAS carries token value in satoshis: 1 satoshi = 1 token unit. Owner and
 * redemption keys are wallet-derived (BRC-42) — never raw keys in the app
 * (Golden Rule 3).
 */
import bsv from 'bsv';
import stasLib from 'stas-js/lib/stas';
import type { WalletClient } from '@bsv/sdk';

/** Canonical STAS BRC-42 protocol id (shared with DSTAS). See stas-knowledge-mcp. */
export const STAS_PROTOCOL_ID: [2, string] = [2, '3241645161d8'];

export interface TokenSchema {
  /** Ticker symbol, no '$' (e.g. "ORCA"). */
  symbol: string;
  /** Total supply in whole units. Equals the satoshis locked (1 sat = 1 unit). */
  supply: number;
  /** Whether token UTXOs can be split (partial sends). Default true. */
  splittable?: boolean;
  /** Optional metadata string embedded in the script (hex-encoded internally). */
  metadata?: string;
}

export interface MintPlan {
  symbol: string;
  supply: number;
  /** Satoshis locked into the token output(s) — equals supply. */
  tokenSatoshis: number;
  /** Token id = hash160(redemption pubkey). */
  tokenId: string;
  ownerAddress: string;
  ownerPkh: string;
  redemptionPubkey: string;
  /** The STAS locking script for the issuance output (hex). */
  stasScriptHex: string;
  estFeeSats: number;
  /** tokenSatoshis + estimated fee — what the issuer's wallet must fund. */
  totalSatsRequired: number;
}

function hash160Hex(pubHex: string): string {
  return bsv.crypto.Hash.sha256ripemd160(Buffer.from(pubHex, 'hex')).toString('hex');
}

/**
 * Pure construction: given the owner + redemption public keys, build the STAS
 * locking script and the mint economics. Verifiable without a wallet.
 */
export function planMint(schema: TokenSchema, ownerPubkeyHex: string, redemptionPubkeyHex: string): MintPlan {
  if (!/^[\w-]+$/.test(schema.symbol)) {
    throw new Error('symbol must be word characters or dashes (no "$")');
  }
  if (!Number.isInteger(schema.supply) || schema.supply <= 0) {
    throw new Error('supply must be a positive integer');
  }

  const ownerPkh = hash160Hex(ownerPubkeyHex);
  const redemptionPublicKey = bsv.PublicKey.fromString(redemptionPubkeyHex);
  const tokenId: string = bsv.crypto.Hash.sha256ripemd160(redemptionPublicKey.toBuffer()).toString('hex');
  const splittable = schema.splittable ?? true;

  // stas-js hex-encodes the symbol + data before getStasScript (issueWithCallback.js).
  const hexSymbol = Buffer.from(schema.symbol).toString('hex');
  const hexData = schema.metadata ? Buffer.from(schema.metadata).toString('hex') : undefined;

  const stasScriptHex: string = stasLib.getStasScript(
    ownerPkh,
    redemptionPublicKey,
    hexData,
    splittable,
    hexSymbol,
  );

  const ownerAddress: string = bsv.PublicKey.fromString(ownerPubkeyHex).toAddress().toString();
  const tokenSatoshis = schema.supply;
  const estFeeSats = 1000;

  return {
    symbol: schema.symbol,
    supply: schema.supply,
    tokenSatoshis,
    tokenId,
    ownerAddress,
    ownerPkh,
    redemptionPubkey: redemptionPubkeyHex,
    stasScriptHex,
    estFeeSats,
    totalSatsRequired: tokenSatoshis + estFeeSats,
  };
}

/** Derive the token's wallet keys (BRC-42) and produce the dry-run mint plan. */
export async function prepareMint(
  wallet: WalletClient,
  schema: TokenSchema,
  tokenKeyId: string,
): Promise<MintPlan> {
  const owner = await wallet.getPublicKey({
    protocolID: STAS_PROTOCOL_ID,
    keyID: `${tokenKeyId}-owner`,
    counterparty: 'self',
  });
  const redemption = await wallet.getPublicKey({
    protocolID: STAS_PROTOCOL_ID,
    keyID: `${tokenKeyId}-redeem`,
    counterparty: 'self',
  });
  return planMint(schema, owner.publicKey, redemption.publicKey);
}

/**
 * Stage 2 (not implemented): assemble the contract + issue transactions via
 * `stas-js` `unsignedContract`/`unsignedIssue`, fund + sign them through the
 * wallet (`createSignature`, per the two-tx funding pattern), and broadcast via
 * ARC. Returns the issuance txid + token id.
 */
export async function buildAndBroadcastMint(): Promise<{ txid: string; tokenId: string }> {
  throw new Error(
    'Not implemented — Stage 2: assemble contract+issue via stas-js unsignedContract/unsignedIssue, ' +
      'fund + sign through the wallet (createSignature, two-tx pattern), broadcast via ARC.',
  );
}
