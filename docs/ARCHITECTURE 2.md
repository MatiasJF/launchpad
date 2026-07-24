# Architecture

How the launchpad is built. Changes only when the structure changes.

## The one constraint

BSV has **no global mutable state**. Tokens are STAS UTXOs (each token amount
lives in a UTXO with a colored-coin script). Any "shared pool everyone hits at
once" is a single-UTXO-contention problem. We avoid it with the **hybrid,
operator-settled** model (ADR-001): the operator sequences actions and settles
them on-chain, so users never race for the same UTXO.

## Modules

```
apps/web        Next.js (App Router) — thin shell over the packages
  app/(public)  browse, project pages, buy flow
  app/(admin)   auth-gated: create project, approve listings
  app/api       backend: sequencing, settlement orchestration

packages/core   domain — entity types & enums, sale logic/state machine.
                No framework, no I/O. The source of truth for the model.
packages/bsv    on-chain — STAS issuance, settlement (build/broadcast/ARC),
                SPV verification, BRC-100 wallet connection.
packages/db     Prisma schema + client (SQLite). Off-chain mirror of state.
```

**Golden rule 4:** business rules live in `core`/`bsv`, never in Next.js routes.
The app calls into the packages; it does not hold logic.

## Data flow — the L0 instant swap (target)

1. **Create (admin-gated).** An authenticated issuer defines a Project + Token;
   an admin approves. Persisted via `packages/db`.
2. **Issue.** `packages/bsv` builds the STAS issuance tx on mainnet; the public
   allocation is split into sale-pool UTXOs. `Token.issuanceTxid` recorded.
3. **Buy.** A buyer connects BSV Desktop (BRC-100) and signs a payment in their
   own wallet — non-custodial.
4. **Sequence + settle.** The operator backend sequences the buy, delivers the
   STAS tokens, and broadcasts via ARC. An `Order` and an append-only `Event`
   are written.
5. **Verify.** The buyer SPV-verifies delivery against the mainnet record.

## Off-chain / on-chain integrity

The database is a convenience mirror, not the source of truth — the chain is.
The `Event` ledger is append-only and its `payloadHash` can be anchored on-chain,
making the off-chain record tamper-evident against mainnet.

## Forward-compatibility

- **Sale types (ADR-008):** `Sale.type` is modelled from day one (`instant` |
  `escrow_presale`); only `instant` is implemented. Escrow slots in as a new type.
- **Hold-and-return (ADR-009):** `Order.state` already carries `refunded` and
  `withdrawn`, so escrow refunds and emergency withdraw become configurations of
  the same settlement engine, not a rewrite.
