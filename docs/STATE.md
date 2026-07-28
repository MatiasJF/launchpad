# Project State

_Last updated: 2026-07-24 — by: P0 scaffold_

## Current phase

**✅ COUNTERFEIT FIX — genesis issuance reworked (2026-07-28, ADR-024) — VERIFIED ON-CHAIN.**
Reissued token `bd7e084371493136a36236dbd927ed8b0aef3835e662f6900e8ae9bd62eda87f:0`
returns WoC back-to-genesis **`result: authentic`** (genesisDepth 0, conservationOk,
tokenId `65ef81c6…`) — contract+funding `501d08…` → issue `bd7e08…` (STAS vout0 +
300 change vout1). The contract→issue genesis works; new mints are genuine STAS. **Full authentic
loop confirmed in-wallet (2026-07-28):** `frl` token renders with its real ticker,
B2G-verified, registered + spendable (1 UTXO) in BSV Desktop — no counterfeit flag.
End-to-end submit→approve→issue→buy→settle→register proven on a genuine token.
(First live token read `counterfeit`: WoC returned `no-genesis` at the mint because
our single-output issuance had no contract ancestor.) Fixed with the classic **contract → issue** genesis (`issueStasGenesis`,
`packages/bsv/src/issue/genesis.ts`; wired into `IssueButton`): contract locks the
supply to the redeem pkh (= tokenId anchor) with an OP_RETURN schema, issue spends
it to mint genesis-valid STAS. Non-custodial (wallet signs both). `recordIssuance`
de-admin-gated (owner issues). Script formats verified offline; on-chain
authenticity is the live test. **Existing `fdr` token stays counterfeit — reissue.**
Also fixed from the first live test: settlement fee ~20× cheaper (was 1 sat/byte →
0.05); auto-resolve retries WoC indexing lag + manual retry button; buy card shows
remaining and caps amount; payout autofill still flaky (manual paste works).

**🏗️ THREE-ROLE MARKETPLACE RESHAPE (2026-07-28, ADR-023) — built, live-test pending.**
The app was a single-operator demo (admin's wallet did everything; buyers didn't
really pay). Restructured into platform / project / buyer, non-custodial throughout:
· **Phase A** — projects owned by the submitter's **BRC-100 identity** (killed the
  `seed-issuer` hardcode); `SubmitForm` connects the wallet and captures a payout
  address. Files: `lib/actions.ts`, `lib/account-actions.ts`, `lib/identity.ts`,
  `components/SubmitForm.tsx`.
· **Phase B** — project **self-service dashboard** `/project/[slug]/manage`
  (owner-gated): the issuer's OWN wallet issues the token and settles its sales.
  Files: `components/ProjectManage.tsx`, `app/project/[slug]/manage/page.tsx`.
· **Phase C** — buyer payment is now **required + verified on-chain**
  (`verifyPaymentToAddress`) against the project payout before the order becomes
  settle-eligible; 100% to the project. Files: `components/BuyCard.tsx`,
  `lib/order-actions.ts`, `lib/settle-actions.ts`.
· **Phase D** — `/admin` slimmed to **listing approve/reject only**; issuance/
  settlement removed from it (now on project dashboards). File: `app/admin/page.tsx`.
The platform holds no keys and does nothing per-project except approve/reject.
**Live-test note:** legacy `seed-issuer` projects (incl. the Sar test) aren't
owner-manageable — submit a fresh project with your wallet to exercise the new flow.

**🎉 FULL MVP LOOP VERIFIED ON MAINNET (2026-07-28).** create → issue → buy →
settle is proven end-to-end: a buyer placed an order and the operator settled it,
tx `73d34b30b8bccdeacd9d720b53e2053748160744c50132e745564b3ced81edb9` delivering
**100 Sar to the buyer** (`13HGL9BfmT1G…`) + **800 Sar change** to the pool. See
WEB-003 below for the settlement hardening path (spent-guard, TX1→TX2 broadcast,
pool auto-resolution).

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
is **indexer-recognized STAS**.

**🎉 SETTLEMENT VERIFIED ON-CHAIN (BSV-003, 2026-07-27):** tx
`1506cffe0e0f07264e0d650fe0475cf6c68b4f98633a8ed49289d454e94811e3` moved
**100 Sar to a recipient** (`a7dbb874…`) + **900 Sar change to sender**, one BSV
change, **covenant satisfied, non-custodial**. The ported two-tx engine, the
`twoTx` primitives, `buildChainedAtomicBeef` (wallet `stas-tokens` basket BEEF),
and browser `bsv-js` bundling are ALL confirmed working — first live try.
**The full MVP loop (create → issue → settle) is now proven on BSV mainnet.**

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

- `●` BSV-003  STAS settlement ✅ VERIFIED ON-CHAIN (tx 1506cf…11e3: 100 Sar → recipient, 900 change, covenant satisfied, non-custodial). Two-tx engine + browser bundling + buildChainedAtomicBeef all confirmed
- `●` WEB-003  Buyer buy flow + admin settle-order — ✅ **VERIFIED ON-CHAIN (2026-07-28)**. Full create→issue→buy→settle loop closed on mainnet: tx `73d34b30…81edb9` moved **100 Sar → buyer `13HGL9BfmT1G…`** + **800 Sar change** to pool owner (`8f00c357…`), spending pool `1506cf…:1`. Pool auto-resolution + TX1→TX2 broadcast + spent-guard all confirmed working.
  **Fixed 2026-07-27 — chained-transfer BEEF bug:** settling from a pool UTXO that
  is a *prior transfer's token change* (not the mint) failed with "must be valid
  AtomicBEEF" — `buildChainedAtomicBeef`'s basket only holds the mint, so the
  source tx was missing from the BEEF. Fix: fetch the source ancestry BEEF
  from-chain (WoC `/tx/{txid}/beef`, incl. merkle proof) via
  `getSourceBeef` and pass it as `StasSource.beef` (storage-agnostic; works for
  any confirmed pool UTXO). Basket path kept as fallback. Verified: nothing had
  broadcast (pool `1506cf…:1` still unspent), so no on-chain cleanup needed.
  **Fixed 2026-07-27 — silent non-broadcast:** after the BEEF fix the settle ran
  with no error but no on-chain tx — two orders were marked settled with txids
  (`830e8e…`, `6bbb76…`) that WoC reports as *unknown*. Root cause: the wallet's
  `internalizeAction` accepts/internalizes TX2 but does NOT reliably broadcast it
  to miners. Fix: `transferStas` now returns the signed `rawTx`; the button
  broadcasts it explicitly via `broadcastRawTx` (WoC `POST /tx/raw`, server-side)
  and only marks the order settled on a real network txid (or surfaces the exact
  miner rejection). `internalizeAction` kept as best-effort change bookkeeping.
  The two bogus "settled" orders were reset to pending (they never landed).
  **Fixed 2026-07-27 — "Missing inputs" (TX1 not propagated):** with explicit
  broadcast the miner returned `Missing inputs` — TX2's funding input (TX1, built
  by `createAction`) was never propagated to WoC's node either. Fix: `transferStas`
  now also returns `fundingRawTx`; the button broadcasts **TX1 first, then TX2**
  to the same node (`broadcastRawTx` tolerates already-known).
  **Diagnosed 2026-07-28 — "Missing inputs" was a SPENT source, not a broadcast
  gap:** with TX1-first broadcast, TX1 (`32255892…`) landed fine but TX2 still
  hit `Missing inputs`. Decoding TX2's inputs on-chain showed it was spending the
  **mint** `97859e…:0` — which BSV-003 already consumed (confirmed spent). The
  settle was pointed at the button's stale `defaultTxid` (the mint) instead of
  the CURRENT pool UTXO. The broadcast path itself is now proven end-to-end.
  Fix: `getOutputInfo` returned script+balance even for spent outputs (WoC's
  `/out/hex` + `/tx` ignore spent-ness), so the operator got no warning until the
  miner rejected. Added `isOutputUnspent` (WoC `/{txid}/{vout}/spent`, 404 =
  unspent) and a guard in the settle button that fails fast with
  "pool UTXO … is already SPENT — enter the CURRENT pool UTXO" before building.
  **Current pool = `1506cf…:1` (900 Sar, pkh `8f00c357…`, unspent).** Next settle
  spends that → 100 Sar to buyer + 800 change.
  **Added 2026-07-28 — pool auto-resolution (kills the stale-txid trap):**
  `resolveCurrentPool(mintTxid)` walks the token change chain on-chain — from the
  mint output it follows each "STAS change back to owner pkh" hop (owner pkh
  derived from the mint's `76a914<pkh>88ac69…` script; recipient/BSV-change
  outputs carry other pkhs) until it reaches an unspent output = the live pool.
  The settle button now auto-fills this on mount (`resolving → resolved`,
  editable override kept). Verified against chain: mint → `1506cf…:1` in one hop,
  correctly skipping the recipient (`a7dbb874…`) and BSV-change outputs. The
  operator no longer hand-tracks the moving UTXO.

**Added 2026-07-28 — buyer receive-register (WEB-003 follow-up #2).** Delivered
tokens land on-chain but the buyer's wallet doesn't track them until internalized.
New `receiveStasToken` (`packages/bsv/src/receive`) does the one call that matters
— `internalizeAction` as a **basket insertion** into `stas-tokens` — making the
tokens render (`listOutputs`) and become spendable. Discovery-scan path (buyer
doesn't hold the transfer BEEF): the settlement tx BEEF is fetched from-chain
(`getSourceBeef`) and passed in; idempotency is basket-based (re-register = no-op).
Buyer UI = `ClaimTokens` on the sale page: "Check my orders" → lists settled
purchases → "Register in wallet" per order (customInstructions stamp the STAS
derivation `protocolID/keyID=slug/counterparty=self` for portable render + spend).
Server action `getBuyerClaimableOrders(identity)` lists a buyer's settled orders.
Recipient token output is always TX2:0. **✅ VERIFIED against BSV Desktop
(2026-07-28):** buyer registered both settled 100-Sar purchases; tokens now
tracked + spendable in-wallet. Fix that made it work: the from-chain WoC BEEF is
a *plain* BEEF, but `internalizeAction` needs **AtomicBEEF** — `receiveStasToken`
now converts via `Beef.fromBinary(beef).toBinaryAtomic(txid)` (pre-validated:
subject tx present, `01010101` atomic prefix). The full buyer journey
create→issue→buy→settle→**receive** is now proven end-to-end on mainnet.

**Multi-hop settlement proven (2026-07-28).** Two live buyer orders settled back-
to-back off the same moving pool: settle #1 `73d34b30…` (100→buyer + 800 change),
settle #2 `334b9213…` (100→buyer + 700 change). Settle #2 spent settle #1's change
UTXO **and** its own still-unconfirmed funding TX1 (`e203488c…:0`) — chaining off
unconfirmed parents without waiting for a block. `resolveCurrentPool` walked
mint→`1506cf`→`73d34b30`→`334b9213` hands-free. Conservation: 1000 mint = 100
(BSV-003) + 100 + 100 delivered + **700 live pool `334b9213…:1`**. (One earlier
attempt aborted silently — the settlement claim's `revalidatePath` unmounted the
live button mid-flow; fixed by removing revalidate from claim/release.)

**Added 2026-07-28 — concurrency hardening (ADR-022).** Two layers:
· **Buy layer** — `placeOrder` now reserves atomically inside a transaction
  (sums `pending|settling|settled` tokens, rejects crossing `allocationForSale`).
  Concurrent buys can't oversell; buys scale freely (no on-chain contention).
· **Settle layer** — single pool UTXO is inherently serial. Added an order-level
  claim (`pending→settling` via one conditional UPDATE) so a double-click / second
  admin tab can't build two transfers for the same order. Released on failure,
  finalized on success. Pool-level throughput at scale = **batch settlement**
  (one tx, N recipient outputs) + optional **UTXO sharding**; settlement stays
  operator-sequenced, pipelined against unconfirmed change. Order.state gained
  `settling`.
· **Reserve-then-pay (2026-07-28, ADR-022 follow-up done)** — buy flow now
  `reserveOrder` (atomic, creates `reserved`) → buyer pays → `confirmOrderPayment`
  (`reserved→pending`, re-checks allocation). Allocation is claimed BEFORE payment,
  so an oversold buyer is rejected up front (no paid-but-refunded case). Abandoned
  reservations lazily expire after a 10-min TTL (counted out of the oversell sum;
  no sweep job). Order.state gained `reserved`. Remaining follow-ups: stale-
  `settling` sweep, Postgres atomic-counter guard, batch settlement.

## Known issues / blockers

- BSV-003 settlement is **VERIFIED ON-CHAIN** (tx 1506cf…11e3). `buildChainedAtomicBeef`'s
  first-pass (wallet `stas-tokens` basket BEEF) is confirmed working. Remaining is
  product, not protocol: the buyer-facing buy flow (WEB-003) that pays sats and
  triggers a settle — plus partial-send bookkeeping (the 900-Sar change UTXO).
- The admin login form's server-action submit didn't fire under headless
  automation (works in a real browser; cookie set directly for testing).

## Open questions

- _(resolved)_ Admin auth → dev-grade admin-secret cookie (ADR-020); revisit for production.

**Added 2026-07-28 — token metadata polish.** Tokens now carry real identity.
Submit captures a logo URL + website (`createProject` stores `Project.logoUrl` +
`links` JSON, https-validated). Genesis OP_RETURN schema enriched with
name/description/image/website (bounded lengths; tokenId anchor unchanged) —
`GenesisArgs` + `issueStasGenesis`, passed through `IssueButton` ← `ProjectManage`
← manage page. UI surfaces it: `SaleCardVM` gains `logoUrl`/`website`; `ProjectCard`
+ sale hero render the logo (letter fallback); sale page shows the website link.
Wallets/explorers that read the STAS schema now see the project name/logo, not a
generic tag. **Re-issue to get the richer on-chain metadata (existing tokens keep
the old minimal schema).**

**Added 2026-07-28 — banner + sale scheduling (owner dashboard).** Project details
editor now also takes a **banner/cover image** (upload data-URI or https URL, stored
in `Project.media` JSON) shown on the sale hero + explore card (gradient fallback).
New **Sale schedule** section: owner sets status (scheduled/live/finalized) + start/end
times (`updateSaleSchedule`, owner-gated). Buyers can only buy while `live`; scheduled
sales show a "starts in" countdown (data.ts countdown uses `startsAt` when scheduled).
Logo/banner accept PNG/ICO/JPG/WEBP uploads. On-chain schema still URL-only for images.
