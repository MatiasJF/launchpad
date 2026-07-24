# Project State

_Last updated: 2026-07-24 — by: P0 scaffold_

## Current phase

**P0 — Foundation & Knowledge Base.** In progress — scaffolding complete,
pending install + first migration verification.

## Task board

Legend: `○` todo · `◐` doing · `●` done · `⨯` blocked
IDs: `AREA-nnn` — flat per-area sequence, not reset by phase.
Areas: OPS · KB · DB · BSV · WEB · ADMIN

**P0 · Foundation & KB**

- `●` OPS-001  Init repo · package manager (pnpm) · tsconfig · lint/format
- `●` OPS-002  Scaffold structure: apps/web + packages/core|bsv|db
- `●` KB-001   Write the KB files (4 boot + reference)
- `●` KB-002   Wire CLAUDE.md golden rules + Definition-of-Done
- `◐` DB-001   Prisma schema: 6 entities on SQLite + first migration

**P1 · Wallet + read path** _(backlog)_

- `○` BSV-001  BRC-100 connect via BSV Desktop; show identity + balance
- `○` WEB-001  Public browse: project list + project page (read-only)
- `○` WEB-002  Design system + component patterns from Mobbin → `docs/DESIGN.md`

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
