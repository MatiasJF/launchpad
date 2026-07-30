# Project State

_Last updated: 2026-07-30 — by: bonding-curve Phase 0 spike_

## Current phase

**🏗️ BONDING-CURVE AMM · PHASE 2 (SELL-BACK) — design + feasibility PROVEN, building (2026-07-30, ADR-027).**
Research (grounded in the real DSTAS swap SDK) proved independent receipt UTXOs CAN'T
be trustless + reserve-safe (a forged AMM receipt sold back drains real sats; authenticity
isn't checkable in bounded Script). So (user chose) balances live INSIDE the pool covenant
as a `HashedMap<ownerPkh,amount>` ledger — no forgeable token exists, reserve drain-proof,
no indexer, no platform key. A holder proves ownership by SIGNATURE on sell. `LedgerPool`
covenant compiles: `buy` credits (new-holder `!has` non-membership branch + existing
`canGet` branch), `sell` debits with owner sig + curve refund + payout; sighash split c3
(buy) / 41 (sell). **Runtime spike PASSED (10/10, off-network):** scrypt-ts runs server-side
as a state calculator — `startTracing→canGet/set→serializedAccessPath()` gives the Merkle
access-path proof, `ledger.data()` the new commitment, `getStateScript()` the successor
script — and **@bsv/sdk `Spend` validates the result**, so our pre-broadcast guard still
works. Gotchas documented (clone-then-set successor; rebuild current map fresh; sold=0n-then-
assign; new-holder needs the `!has` branch just added). **Ledger state service BUILT + buy proven (4/4):** `packages/curve/service/ledgerState.ts`
runs scrypt-ts server-side (runtime dep, compiled with tsc — esbuild/tsx use new-style
decorators that break scrypt-ts). `computeBuySpend` builds the pool unlock via scrypt-ts
`getUnlockingScript` (correct arg encoding + HashedMap access path) and **@bsv/sdk `Spend`
validates it** — new-holder-into-empty-ledger, existing-holder, 2nd-holder, underpay-reject.
Key discipline: clone cur's ACTUAL map (`new HashedMap(cur.ledger)`) for the successor, not
a fresh mkLedger, else re-lock fails. **COVENANT SIDE COMPLETE + drain-proof (13/13, `pnpm --filter @launchpad/curve test:ledger`):**
buy (4) — new/existing holder, underpay reject; sell (3) — holder-signed debit validates,
over-debit + bad-sig reject (sig over sha256sha256(preimage) = our wallet path); adversarial
(6) — inflated payout, shrunk pool reserve, swapped successor, redirected payout, over-credited
buy all REJECTED by hashOutputs (buy pins out0 via ANYONECANPAY_SINGLE; sell pins both outs via
ANYONECANPAY_ALL). Everything routes through the server-side state service (`service/ledgerState.ts`,
scrypt-ts→getUnlockingScript) and re-verifies in @bsv/sdk `Spend`. **SERVER-SIDE INTEGRATION DONE — web builds green.** Next drives the scrypt-ts state service
as a CHILD PROCESS (`packages/curve/service/cli.ts`, JSON in/out) so scrypt-ts is never bundled
into Next (feasibility gate PASSED). `apps/web/lib/ledger-service.ts` (server-only execFile
bridge) + `ledger-actions.ts` (createLedgerPool/deploy, getLedgerPool, prepare+recordLedgerBuy,
two-step prepare/finalize/recordLedgerSell — optimistic outpoint guards + mirror-ledger JSON in
`CurvePool.ledgerBalances`, variant='ledger'). Build the service first: `pnpm --filter
@launchpad/curve build:service`. **Remaining = CLIENT side only:** (1) buy flow — prepareLedgerBuy
→ build tx [pool input(server unlock) + wallet payment input] → broadcast → recordLedgerBuy
(mirror the linear card's TX1-prebroadcast fix); (2) sell flow — prepareLedgerSell(digest) →
wallet createSignature → finalizeLedgerSell(unlock) → build tx [pool + fee input] → broadcast →
recordLedgerSell; (3) a ledger buy/sell card + variant wiring on the sale page + ledger deploy in
manage; (4) dust-amount live buy+sell. Covenant + server 100% done + drain-proof; live buy-only
`LinearCurvePool` pools unaffected.

**✅ BONDING-CURVE AMM · PHASE 1 (BUY-ONLY CURVE) — PROVEN ON MAINNET (2026-07-30, ADR-026).**
A real non-custodial curve buy confirmed on-chain: buy tx
`6bcdbb97b50f32188b7982f2c86033744f51d3f7b5061770d3e7ce1761909e4b` spends the pool
covenant `c17f549d…:0` with **NO signature** (1877-byte pushed delta/newReserve/preimage)
+ a buyer P2PKH payment input → out0 re-locks byte-identically to the sold=5 successor
pool (reserve 546→561, cost 15 = exact `5·6/2`) + out1 546-sat token receipt to the
buyer. The covenant enforced the price on-chain and self-replicated with advanced state.
Also fixed a "Missing inputs" race (pre-broadcast TX1 to WoC + retry) and moved the pool
deploy into ProjectManage (owner action). **Phase 1 done. Next: Phase 2 (sell-back).**
Detail below ↓

**🏗️ BONDING-CURVE AMM · PHASE 1 (BUY-ONLY CURVE) — covenant core GREEN offline (2026-07-30, ADR-026).**
The `LinearCurvePool` reserve covenant compiles and passes its math battery in the
@bsv/sdk interpreter (`packages/curve`, 15/15). Enforces `cost = k·delta·(2·sold+
delta+1)/2` (exact /2), `newReserve ≥ reserveBefore + cost` (verify-invariant,
rounds for the pool), supply cap, and self-replication to the `sold+delta`
successor. Tests cover: exact-cost accept, overpay accept, underpay-by-1 reject,
wrong-successor reject, oversupply reject, zero-delta reject, chaining, whole-supply
buy. Caught + fixed a real audit-surface bug: small int args (delta 1..16) must use
minimal `OP_N` pushes or the interpreter rejects "not minimally-encoded". Module:
`src/contracts/linearCurvePool.ts` (source), `src/curvePool.ts` (@bsv/sdk buy
spend/verify). **On-chain core COMPLETE + tested (18/18):** added runtime successor-
script derivation (`poolScriptForSold`, scrypt-ts-free, byte-matches every compiled
fixture incl. high-bit padding — the pool-brick risk, eliminated) and the non-custodial
buy assembly (`buildCurveBuyTx`, `src/buyAssembly.ts`): two-tx like settle/batch —
buyer funds an exact BRC-29 payment input, TX2 = [pool covenant input (push
delta/newReserve/preimage), buyer payment input signed ALL 0x41] → [successor pool @
reserveBefore+cost, buyer token receipt]; pre-broadcast interpreter guard. Routing
note: scouting found successor-derivation to be a money-critical byte-format problem
that must NOT be parallelized, so the core was built directly (not via /orchestrate).
**Plumbing COMPLETE — web builds green:** DB `CurvePool` + migration; server actions
`apps/web/lib/curve-actions.ts` (create/deploy/state + operator-sequenced `recordCurveBuy`
with an optimistic outpoint guard so a raced buy can't corrupt tracked state); owner
deploy `CurvePoolDeploy.tsx`; buyer `CurveBuyCard.tsx` (shows live curve cost, funds+signs
own payment); owner sets `bonding_curve` in ProjectManage Presale tab (`updateSaleEscrow`);
sale page renders deploy-or-buy by pool status. Phase-1 limit: pools use compiled params
(k=1, supply=1000) since k/supply are script constants — arbitrary params need runtime
script-gen (fast-follow). **Only step left: one live mainnet buy** — owner sets type →
deploys pool → buyer buys along the curve (needs wallet, ring the user).

**✅ BONDING-CURVE AMM · PHASE 0 — PROVEN ON MAINNET (2026-07-30, ADR-026).**
A stateful OP_PUSH_TX covenant self-replicated on-chain: deploy
`71407ee6e6f7874969f7d8ce076a4f5d1ce7d77ff82380793390b70e94ac6e7b` (covenant
count=0 at vout 0), increment
`1f5e95080ad611ac1a4e2d0be58d89675f5dc02d87aacf1f15ce63b997282f7c` — spends the
covenant with **NO signature on that input** (1761-byte pushed tx preimage) + a
P2PKH fee input, and out0 re-locks byte-identically to the count=1 successor
script (`ls1`). Non-custodial, verify-invariant covenant mechanism confirmed live.
Two false-alarm fixes on the way (dummy-outpoint guard; extensionless imports for
Next). **Phase 0 done — the approach is validated. Next: Phase 1 (buy-only linear
curve).** Detail below ↓

**🧪 BONDING-CURVE AMM · PHASE 0 (TOOLCHAIN SPIKE) — GREEN (2026-07-30, ADR-026).**
The trustless AMM (`pump.fun`-style buy/sell against an on-chain reserve) needs a
**stateful OP_PUSH_TX covenant**. Phase 0 de-risked the whole approach with a
trivial `Counter` covenant (state may only increment by +1) — all the covenant
machinery, none of the curve math. `packages/curve`:
· scrypt-ts **compiles a stateful covenant to Bitcoin Script** (the compiled
  `Tx.checkPreimage` forged-sig construction + `hash256(hashOutputs)` self-
  replication constraint are visible in `artifacts/counter.scrypt`);
· it **executes correctly in `@bsv/sdk`'s own Script interpreter** — our production
  runtime, not scrypt-ts: `count 0→1` accepted, `0→0` and `0→2` rejected, `1→2`
  accepted (`pnpm --filter @launchpad/curve test`, 4/4 green).
**Toolchain gotcha (documented):** scrypt-ts-transpiler needs TS ~5.3; pnpm's
workspace hoisting gives it 5.9 and the transform silently emits nothing. Fix:
compile in an isolated npm project (`scripts/compile.sh`), commit the hex. sCrypt
is build-time only — runtime is `@bsv/sdk` + committed artifacts.
**Live bench built (pending on-chain run):** admin-gated `/admin/covenant` deploys
the covenant (count=0) via a wallet `createAction`, then hand-assembles + broadcasts
the increment spend — covenant input carries NO signature (just the pushed BIP-143
preimage, OP_PUSH_TX); a second wallet-owned input pays the fee (the covenant pins
successor.value == covenant.value, so no fee can be skimmed from it). Pre-broadcast
it cross-checks the bsv-js preimage against the @bsv/sdk one. Module:
`packages/curve/src/spike.ts`. **Remaining: the user runs the two mainnet txs in
BSV Desktop** — the only manual wallet step; then Phase 0 is closed on-chain.
**Next:** Phase 1 — buy-only linear-curve covenant (verify-invariant, round against
the taker), covenant-native token, operator-sequenced. See ADR-026 for the plan.



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

**Added 2026-07-28 — markdown descriptions.** Project description is now **Markdown**
(react-markdown + remark-gfm), rendered safely: React elements only (no raw-HTML
injection), links restricted to http(s), images to https — headings, lists, links,
tables and inline images with zero XSS surface. `components/Markdown.tsx`, `.md`
styles in globals.css. Sale-page About renders it; dashboard has a live preview.

**🏗️ L2 ESCROW PRESALE — built (2026-07-29, ADR-025), live-test pending.** Trustless
soft-cap presale via SIGHASH_ANYONECANPAY dominant-assurance contract, non-custodial.
Verified offline: an `0xC1` pledge signed alone still verifies after other inputs join.
· **Engine (packages/bsv):** `createPledge` (mint exact-value UTXO + 0xC1 sign, no
  broadcast) · `assembleAssuranceTx` (pledges + fee input → fixed soft-cap output).
· **Flow:** owner configures escrow (Presale tab: type/softCap/hardCap/pledgeUnit) →
  contributor pledges on the sale page (`ContributeCard`; funds stay in their wallet)
  → when soft cap met, owner assembles + broadcasts (Presale tab) → each funded pledge
  becomes a settle-eligible Order → tokens delivered via the existing settlement flow.
· **Trustless:** intake, refund (nothing taken), emergency withdraw (spend the UTXO).
  **Not trustless:** delivery is operator-signed (classic STAS can't atomic-deliver in
  the crowd tx). Files: `packages/bsv/src/pledge/`, `apps/web/lib/escrow-actions.ts`,
  `apps/web/components/ContributeCard.tsx`, Presale tab in `ProjectManage.tsx`.

**Added 2026-07-29 — batch settlement (ADR-022 lever).** `batchTransferStas`
(`packages/bsv/src/settle/batch.ts`) spends the pool ONCE → N recipient token
outputs + token-change + one BSV change, delivering every pending order in a single
tx (was N sequential settles, each moving the pool). Owner dashboard → Orders tab →
"Settle all N in one tx". Server: `getBatchForSale` / `markOrdersSettled`. The right
tool for escrow presales with many contributors.

**Added 2026-07-30 — instant-buy above soft cap (completes ADR-025).** Once an escrow
presale's soft cap is assembled (`assured` = assembled pledges exist), the sale stays
LIVE and switches from pledge → **instant buy** for the top-up up to the hard cap. Config
sets `allocationForSale = hardCap/price`; `markAssemblyBroadcast` keeps status live;
sale page shows `ContributeCard` while unassured, `BuyCard` once assured; `reserveOrder`
blocks instant buys during the pledge phase. Presale tab shows "✓ Soft cap funded".
