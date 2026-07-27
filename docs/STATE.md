# Project State

_Last updated: 2026-07-24 — by: P0 scaffold_

## Current phase

**P1 done; P2 started.** Explore + sale pages now read from **SQLite** (DB-002 ✅,
verified in-browser). Admin-gated project **submit + approval** flow is live
(ADMIN-001 ✅). Wallet connect done (BSV-001). Tailwind v4 + navy palette.
STAS issuance (BSV-002 ✅ — classic STAS, non-custodial, ADR-021): mint
construction (`planMint`, tested) → server plan (`lib/mint.ts`) → **wallet
`createAction`** signs + broadcasts (non-custodial, keys stay in wallet) →
`recordIssuance`. Issue-token UI + confirm gate on `/admin`.
**🎉 VERIFIED ON-CHAIN (2026-07-27):** first real mint broadcast — tx
`97859e490fd29f2b6af14f5eb14c0d661a82cc3203b11af97d5b4ab499d563f1` vout 0 is a
WhatsOnChain-STAS-tagged **1,000-token "Sar"**, owner pkh `8f00c357…d3ee`, token
id `07871ba5…370f`; DB recorded. Confirms non-custodial `createAction` issuance
is **indexer-recognized STAS**. **This UTXO is the BSV-003 settlement test target.**

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
- `●` DB-002   Seed script → SQLite; explore/sale read via Prisma (dynamic pages)
- `●` WEB-002  Design system + component patterns from Mobbin → `docs/DESIGN.md`

**P2 · Admin-gated issuance** _(backlog)_

- `●` ADMIN-001  Submit form → pending project; admin-secret gate; approve/reject (ADR-020)
- `●` BSV-002    STAS issuance ✅ VERIFIED ON-CHAIN (tx 97859e…563f1, WoC-tagged STAS, "Sar" 1000). Non-custodial mint via wallet createAction; Issue-token UI

**P3 · L0 instant swap (MVP)** _(backlog)_

- `◐` BSV-003  Settlement wired end-to-end: engine ported, browser bsv-js bundling ✅, SettleButton on /admin, first-pass buildChainedAtomicBeef. Runnable — needs a live transfer to verify (like the mint)
- `○` WEB-003  Buy UI; ARC broadcast + SPV verify; record Order + Event

## Known issues / blockers

- BSV-003 settlement is **wired + runnable but not yet verified on-chain**:
  browser `bsv-js` bundling done (webpack fallbacks in next.config), SettleButton
  on `/admin`. `buildChainedAtomicBeef` is a first-pass (fetches the token BEEF
  from the wallet's `stas-tokens` basket) — run a live transfer of the "Sar"
  token to verify/iterate (same loop that got the mint working).
- The admin login form's server-action submit didn't fire under headless
  automation (works in a real browser; cookie set directly for testing).

## Open questions

- _(resolved)_ Admin auth → dev-grade admin-secret cookie (ADR-020); revisit for production.
