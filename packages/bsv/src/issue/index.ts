/// <reference path="../vendor.d.ts" />

/**
 * STAS token issuance — non-custodial (ADR-021).
 *
 * `planMint` builds the classic STAS locking script + mint economics from
 * wallet-derived owner/redemption public keys. It runs SERVER-SIDE (uses the
 * heavy `bsv` + `stas-js` libs) — see `apps/web/lib/mint.ts`. The client wallet
 * only derives the keys and signs/broadcasts the `createAction` (bsv/stas-js
 * never reach the browser bundle).
 *
 * Issuance inputs satisfy no covenant, so the wallet's normal funding/change is
 * safe here; the two-transaction flow is only needed for transfers (BSV-003).
 * STAS carries value in satoshis: 1 satoshi = 1 token unit. Keys are
 * wallet-derived (BRC-42), never raw keys in the app (Golden Rule 3).
 */
import bsv from 'bsv';
import stasLib from 'stas-js/lib/stas';

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
