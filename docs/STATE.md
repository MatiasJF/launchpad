# Project State

_Last updated: 2026-07-24 — by: P0 scaffold_

## Current phase

**P1 — Wallet + read path.** Browse UI complete (WEB-001) + wallet connect
implemented (BSV-001, `WalletClient 'auto'`). Tailwind v4 + navy palette.
Remaining: exercise wallet vs a running BSV Desktop; wire Prisma reads (DB-002).

_P0 — Foundation & Knowledge Base: ✅ Complete (commit `d28a719`). Scaffold built,
migration applied, verified by `prisma validate`, `core`/`bsv`/`db` typecheck,
`next build`, and a 4-dimension adversarial verification pass._

## Task board

Legend: `○` todo · `◐` doing · `●` done · `⨯` blocked
IDs: `AREA-nnn` — flat per-area sequence, not reset by phase.
Areas: OPS · KB · DB · BSV · WEB · ADMIN

**P0 · Foundation & KB**

- `●` OPS-001  Init repo · package manager (pnpm) · tsconfig · lint/format
- `●` OPS-002  Scaffold structure: apps/web + packages/core|bsv|db
- `●` KB-001   Write the KB files (4 boot + reference)
- `●` KB-002   Wire CLAUDE.md golden rules + Definition-of-Done
- `●` DB-001   Prisma schema: 6 entities on SQLite + first migration

**P1 · Wallet + read path** _(backlog)_

- `●` BSV-001  BRC-100 connect (WalletClient 'auto'); identity + balance in header — verify vs a running wallet
- `●` WEB-001  Public browse: landing + explore + project/sale detail (read-only, seed data)
- `○` DB-002   Seed script → SQLite; swap explore/sale from seed to Prisma reads
- `●` WEB-002  Design system + component patterns from Mobbin → `docs/DESIGN.md`

**P2 · Admin-gated issuance** _(backlog)_

- `○` ADMIN-001  Auth gate + admin approval flow
- `○` BSV-002    STAS issuance tx on mainnet; split public allocation to pool

**P3 · L0 instant swap (MVP)** _(backlog)_

- `○` BSV-003  Fixed-price buy: user signs, operator sequences + settles
- `○` WEB-003  Buy UI; ARC broadcast + SPV verify; record Order + Event

## Known issues / blockers

- None yet.

## Open questions

- Admin auth: BRC-100 identity vs simple credential — decide in P2 (ADMIN-001).
