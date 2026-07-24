/**
 * Domain entity types and enum-like unions.
 *
 * These are the source of truth for the model. SQLite does not support Prisma
 * enums (ADR-011), so the corresponding schema fields are `String`; these
 * `as const` unions enforce the allowed values in TypeScript. Keep in sync with
 * `packages/db/prisma/schema.prisma` and `docs/SCHEMA.md`.
 */

export const ROLES = ['admin', 'issuer', 'public'] as const;
export type Role = (typeof ROLES)[number];

export const PROJECT_STATUSES = ['draft', 'pending', 'approved', 'live', 'closed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SALE_TYPES = ['instant', 'escrow_presale'] as const;
export type SaleType = (typeof SALE_TYPES)[number];

export const SALE_STATUSES = ['scheduled', 'live', 'finalized', 'failed'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const ORDER_KINDS = ['instant_buy', 'escrow_contribution'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_STATES = ['pending', 'settled', 'refunded', 'withdrawn', 'failed'] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** Runtime guard for any of the `as const` unions above. */
export function isOneOf<T extends readonly string[]>(
  values: T,
  candidate: string,
): candidate is T[number] {
  return (values as readonly string[]).includes(candidate);
}

export interface Account {
  id: string;
  identityPubkey: string;
  paymail?: string | null;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  media?: string | null;
  links?: string | null;
  team?: string | null;
  docs?: string | null;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenAllocations {
  public: bigint;
  team?: bigint;
  treasury?: bigint;
  rewards?: bigint;
  airdrop?: bigint;
}

export interface Token {
  id: string;
  projectId: string;
  name: string;
  ticker: string;
  decimals: number;
  totalSupply: bigint;
  allocations?: string | null;
  stasTokenId?: string | null;
  issuanceTxid?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Sale {
  id: string;
  tokenId: string;
  type: SaleType;
  priceSats: bigint;
  allocationForSale: bigint;
  startsAt?: Date | null;
  endsAt?: Date | null;
  softCap?: bigint | null;
  hardCap?: bigint | null;
  status: SaleStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order {
  id: string;
  saleId: string;
  buyerIdentity: string;
  kind: OrderKind;
  tokens: bigint;
  satsPaid: bigint;
  state: OrderState;
  txid?: string | null;
  refundTxid?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Event {
  id: string;
  entity: string;
  entityId: string;
  type: string;
  actorId?: string | null;
  payloadHash?: string | null;
  createdAt: Date;
}
