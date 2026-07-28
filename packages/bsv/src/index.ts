/**
 * On-chain module for the launchpad: STAS issuance, settlement, SPV, and the
 * BRC-100 wallet connection. All stubs for now — implemented across P1–P3.
 *
 * Mainnet always (ADR-003). Never handle wallet secrets (golden rule 3): users
 * sign in their own wallet (BSV Desktop); this module builds and verifies, it
 * does not custody keys.
 */

export * from './notImplemented';
export * from './issue';
export * from './settle';
export * from './receive';
export * from './spv';
export * from './wallet';
