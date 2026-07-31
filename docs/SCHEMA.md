# Data Model

Source of truth in prose. Mirrors `packages/db/prisma/schema.prisma` and the
union types in `packages/core/src/entities`. Keep all three in sync (golden
rule 1).

## Enum-like fields on SQLite

SQLite does **not** support Prisma enums (ADR-011). Enum-like fields are stored
as `String`, with allowed values documented here and in the schema, and enforced
by the `as const` union types in `packages/core`.

| Field group   | Allowed values                                              |
| ------------- | ----------------------------------------------------------- |
| Role          | `admin` · `issuer` · `public`                               |
| ProjectStatus | `draft` · `pending` · `approved` · `live` · `closed`        |
| SaleType      | `instant` · `escrow_presale`                                |
| SaleStatus    | `scheduled` · `live` · `finalized` · `failed`               |
| OrderKind     | `instant_buy` · `escrow_contribution`                       |
| OrderState    | `pending` · `settled` · `refunded` · `withdrawn` · `failed` |

## Entities

Chain of custody: `Account → Project → Token → Sale → Order`, with `Event` as an
append-only audit ledger referencing any entity.

### Account

An authenticated identity. `identityPubkey` is the BRC-100 identity key.
Fields: `id`, `identityPubkey` (unique), `paymail?`, `role` (default `public`),
`projects[]`, `events[]`, timestamps.

### Project

A team/business launching a token.
Fields: `id`, `ownerId → Account`, `slug` (unique), `name`, `tagline?`,
`description?`, `logoUrl?`, `media?` (JSON), `links?` (JSON), `team?` (JSON),
`docs?` (JSON), `status` (default `draft`), `tokens[]`, timestamps.

### Token

A STAS token issued by a project.
Fields: `id`, `projectId → Project`, `name`, `ticker`, `decimals` (default 0),
`totalSupply` (BigInt), `allocations?` (JSON: public/team/treasury/rewards/
airdrop), `stasTokenId?`, `issuanceTxid?`, `sales[]`, timestamps.

### Sale

An offering of a token's public allocation.
Fields: `id`, `tokenId → Token`, `type` (default `instant`), `priceSats`
(BigInt, sats per token), `allocationForSale` (BigInt), `startsAt?`, `endsAt?`,
`softCap?` (BigInt), `hardCap?` (BigInt), `status` (default `scheduled`),
`orders[]`, `curvePool?`, timestamps. `type` ∈ `instant` · `escrow_presale` ·
`bonding_curve`.

### CurvePool

A bonding-curve AMM reserve pool (ADR-026, Phase 1). ONE on-chain covenant UTXO
whose satoshi balance is the reserve and whose script carries `sold`; this row
mirrors that UTXO's current state so the operator can sequence buys against the
latest outpoint. Non-custodial — outpoints/scripts only, never keys.
Fields: `id`, `saleId → Sale` (unique), `k` (BigInt, price slope), `supply`
(BigInt, max sellable), `sold` (BigInt, default 0 = covenant state),
`seedReserveSats` (BigInt, deploy base), `reserveSats` (BigInt, current UTXO
value), `poolTxid?`/`poolVout?`/`scriptHex?` (current outpoint — moves each buy),
`status` (`draft` · `live` · `graduated`), timestamps. A buy is recorded as an
`Order` with `kind = curve_buy`.

### Order

A buy (instant) or contribution (escrow) against a sale.
Fields: `id`, `saleId → Sale`, `buyerIdentity` (BRC-100 pubkey), `kind`
(default `instant_buy`; also `curve_buy` · `curve_sell`), `tokens` (BigInt),
`satsPaid` (BigInt), `state` (default `pending`), `paymentTxid?`, `txid?`,
`refundTxid?`, timestamps.
`curve_sell` (ADR-028 step-3) replay guard: `returnVout?` (Int) + `sellReturnOutpoint?`
(`${returnTxid}:${vout}`, **@unique**) — one on-chain STAS return backs at most one sell
refund (a duplicate insert throws P2002). Migration
`20260731140000_order_sell_return_outpoint`.

### Pledge

A SIGHASH_ANYONECANPAY assurance-contract pledge for an escrow presale (ADR-025).
Non-custodial: only the contributor's `0xC1` signature + their exact-value UTXO
outpoint are stored; funds stay in the contributor's wallet until the assurance
tx is assembled + broadcast on success.
Fields: `id`, `saleId → Sale`, `contributor` (BRC-100 pubkey), `receiveAddress`,
the pledged UTXO (`txid`, `vout`, `satoshis`, `scriptHex`), the pledge signature
(`sigHex`, `pubkeyHex`), `derivationPrefix?`/`derivationSuffix?`, `state`
(`pledged` · `withdrawn` · `assembled` · `expired`), timestamps.

### Event

Append-only audit ledger.
Fields: `id`, `entity`, `entityId`, `type`, `actorId? → Account`,
`payloadHash?` (anchored on-chain), `createdAt`.

## Notes

- Amounts (`totalSupply`, `priceSats`, `allocationForSale`, caps, `tokens`,
  `satsPaid`) are `BigInt` — token/satoshi values exceed 32-bit range.
- JSON-shaped fields are stored as stringified JSON on SQLite; typed accessors
  live in `packages/core`.
