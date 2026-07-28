# Decision Log (ADR)

Append-only; newest at the bottom. Template per entry:
`Status · Date — Context — Options — Decision — Consequences`.

---

## ADR-001 · Trust model · Accepted · 2026-07-23

- **Context:** BSV has no global mutable state; the launchpad needs pricing + settlement.
- **Options:** (a) fully on-chain sCrypt covenant · (b) hybrid operator-settled · (c) custodial DB.
- **Decision:** (b) Hybrid — issuance/holdings/settlement are on-chain STAS UTXOs (SPV-verifiable); the pricing/matching engine is the operator backend.
- **Consequences:** fastest credible path; users trust the operator to settle honestly (auditable on-chain); can harden toward covenants later.

## ADR-002 · MVP scope · Accepted · 2026-07-23

- **Context:** Reference platforms carry huge feature lists (staking, AMM, farms).
- **Options:** (a) match their breadth · (b) offering engine only · (c) broad-but-shallow.
- **Decision:** (b) Offering engine — fixed-price issuance + sale + panel + admin curation.
- **Consequences:** ~80% of value at ~40% of difficulty; other primitives deferred to layers.

## ADR-003 · Network · Accepted · 2026-07-24

- **Context:** Need a target network for issuance and settlement.
- **Options:** (a) testnet first · (b) mainnet always.
- **Decision:** (b) Mainnet always — no testnet fallback (user directive).
- **Consequences:** real sats, permanent records; demo tokens must be labelled + admin-gated.

## ADR-004 · Token protocol · Accepted · 2026-07-24

- **Context:** Need a UTXO-native token standard.
- **Options:** STAS, among available BSV token protocols.
- **Decision:** STAS (user-confirmed).
- **Consequences:** supply minted at issuance into UTXOs; transfer = spend + recreate.

## ADR-005 · Wallet interface · Accepted · 2026-07-24

- **Context:** Users must connect a wallet and sign their own txs.
- **Options:** (a) BRC-100 standard interface · (b) custom integration.
- **Decision:** (a) BRC-100; BSV Desktop as the first target wallet.
- **Consequences:** non-custodial; standard app-to-wallet interface; other wallets later.

## ADR-006 · Fees · Accepted · 2026-07-24

- **Context:** Platform could take a cut of issuance/volume.
- **Options:** (a) charge fees · (b) none for now.
- **Decision:** (b) No fees in the MVP (user directive).
- **Consequences:** simpler first demo; revisit as a lever later.

## ADR-007 · Curation gate · Accepted · 2026-07-24

- **Context:** Listings need vetting; legal/KYC is out of scope for the demo.
- **Options:** (a) legal/compliance process · (b) admin-authenticated approval.
- **Decision:** (b) Admin-gated approval as the stand-in.
- **Consequences:** proves the loop without legal overhead; legal revisited before scale.

## ADR-008 · Sale-type abstraction · Accepted · 2026-07-24

- **Context:** Escrow presales (refunds, emergency withdraw) are a likely future layer.
- **Options:** (a) model only instant now · (b) carry `Sale.type = instant | escrow_presale`.
- **Decision:** (b) Model the type from day one; implement only instant.
- **Consequences:** escrow slots in later as a new type — no data-model rewrite.

## ADR-009 · Settlement shape · Accepted · 2026-07-24

- **Context:** Escrow needs to hold and return funds, not only deliver.
- **Options:** (a) deliver-only settlement · (b) hold-and-return settlement.
- **Decision:** (b) `Order.state` carries `refunded` + `withdrawn`; settlement can return funds.
- **Consequences:** refunds/emergency-withdraw become configs of one engine (pairs ADR-008).

## ADR-010 · Stack · Accepted · 2026-07-24

- **Context:** Web app + admin + BSV settlement code share one codebase.
- **Options:** (a) TS + Next.js · (b) TS + separate API/SPA · (c) other language split.
- **Decision:** (a) TypeScript + Next.js (App Router).
- **Consequences:** shared types end-to-end; matches BSV SDK/MCP tooling.

## ADR-011 · Storage · Accepted · 2026-07-24

- **Context:** Need persistence for the six entities in the MVP.
- **Options:** (a) SQLite via Prisma · (b) Postgres from day one · (c) files/in-memory.
- **Decision:** (a) SQLite via Prisma now → Postgres later.
- **Consequences:** zero-setup fast MVP; the same Prisma schema migrates cleanly. Note: SQLite does not support Prisma enums, so enum-like fields are `String` with allowed values documented in the schema and enforced by the union types in `packages/core`.

## ADR-012 · Knowledge base · Accepted · 2026-07-24

- **Context:** The project must be resumable from cold after context loss.
- **Options:** (a) ad-hoc README · (b) 8-file KB + Definition-of-Done protocol.
- **Decision:** (b) Self-updating 8-file KB; no change done until the KB reflects it.
- **Consequences:** 3-file cold start; a small upkeep tax per change (CLAUDE.md rule 1).

## ADR-013 · Repo layout · Accepted · 2026-07-24

- **Context:** Keep hard-to-get-right logic testable and framework-independent.
- **Options:** (a) logic in Next.js routes · (b) logic in `packages/`, app as thin shell.
- **Decision:** (b) `packages/core` + `packages/bsv` + `packages/db`; `apps/web` is a shell.
- **Consequences:** domain/on-chain logic unit-testable; framework swappable.

## ADR-014 · Commit convention · Accepted · 2026-07-24

- **Context:** Default tooling appends co-author/session trailers to commits.
- **Options:** (a) keep trailers · (b) plain commit messages.
- **Decision:** (b) No `Co-Authored-By` or `Claude-Session` trailers (user directive).
- **Consequences:** clean git history; CLAUDE.md rule 6.

## ADR-015 · Build workflow · Accepted · 2026-07-24

- **Context:** Multi-file build work benefits from decomposition + verification.
- **Options:** (a) ad-hoc solo edits · (b) `/orchestrator:orchestrate` multi-agent.
- **Decision:** (b) Drive build work through `/orchestrator:orchestrate` (user directive).
- **Consequences:** decompose → fan out → verify; CLAUDE.md rule 7.

## ADR-016 · UI component sourcing · Accepted · 2026-07-24

- **Context:** The product UI should feel polished — proven launchpad/fintech patterns, not screens invented from scratch.
- **Options:** (a) design from scratch · (b) reference real app patterns via Mobbin.
- **Decision:** (b) Source component/screen patterns from Mobbin (`api.mobbin.com/mcp`, user has an account) during frontend work; capture the resulting system in `docs/DESIGN.md`.
- **Consequences:** faster, more credible UI; Mobbin MCP connected at user scope. Our own token/theme system still owns the brand.

## ADR-017 · App design language · Accepted · 2026-07-24

- **Context:** The product app needs one coherent visual language; surveyed real launchpad/web3 UIs on Mobbin (see docs/DESIGN.md references).
- **Options:** (a) light-first like the planning docs · (b) dark-first, crypto-convention · (c) single-theme only.
- **Decision:** (b) Dark-first and theme-aware (light via `data-theme` / `prefers-color-scheme`), carrying brand accents gold=value, teal=verified. Tokens in `apps/web/app/globals.css`, primitives in `apps/web/components/ui`, documented in `docs/DESIGN.md`.
- **Consequences:** matches category expectations; one accent per view; the planning-doc artifacts keep their separate print-ish identity.

## ADR-018 · Styling: Tailwind CSS v4 · Accepted · 2026-07-24

- **Context:** The app needs a scalable styling system; design tooling and component libraries (e.g. shadcn/ui) target Tailwind.
- **Options:** (a) hand-rolled CSS classes · (b) Tailwind v4 with tokens mapped via `@theme` · (c) CSS-in-JS.
- **Decision:** (b) Tailwind CSS v4. Design tokens stay CSS variables on `:root` (theme-switchable) and are exposed to Tailwind via `@theme inline`, so `docs/DESIGN.md` remains the source of truth and utilities (`bg-surface`, `text-gold`) are theme-aware. Repeated primitives live in a small `@layer components` block.
- **Consequences:** idiomatic utility styling, dark/light via token overrides, shadcn/ui-compatible; `apps/web/postcss.config.mjs` wires `@tailwindcss/postcss`.

## ADR-019 · Wallet connection · Accepted · 2026-07-24

- **Context:** Users must connect a BRC-100 wallet (BSV Desktop) for identity, balance, and later signing.
- **Options:** (a) `@bsv/sdk` `WalletClient('auto')` · (b) a custom substrate/integration.
- **Decision:** (a) `WalletClient('auto')` in `packages/bsv/src/wallet` (probes `window.CWI` + local wallet substrates); non-custodial — keys stay in the user's wallet. The SDK is **lazy-loaded** in the web app on connect to keep the initial bundle light (~100 kB deferred).
- **Consequences:** standard BRC-100 flow (`waitForAuthentication` → `getPublicKey` → `getNetwork`); requires a running BRC-100 wallet to exercise end-to-end.

## ADR-020 · Admin auth · Accepted · 2026-07-24

- **Context:** Listings need an admin approval gate (ADR-007); this resolves the open "BRC-100 identity vs simple credential" question.
- **Options:** (a) BRC-100 identity allowlist · (b) dev-grade admin-secret cookie · (c) full auth provider.
- **Decision:** (b) A server-verified `ADMIN_SECRET` (env) that sets an httpOnly `admin_session` cookie; server actions check it. **Placeholder, not production security.**
- **Consequences:** unblocks the approval flow now; revisit with BRC-100 identity or a real auth provider before public launch.

## ADR-021 · Token protocol: Classic STAS, non-custodial, mainnet · Accepted · 2026-07-24

- **Context:** Research (BSV SDK expert + the user's `stas-knowledge-mcp`) showed how to reconcile STAS with our non-custodial signer choice. User confirmed STAS over wallet-native and directs mainnet-only (no testnet). Refines ADR-004.
- **Options:** (a) wallet-native PushDrop/BTMS · (b) classic STAS via non-custodial BRC-100 · (c) `stas-js` headline API with raw keys (rejected — violates Golden Rule 3).
- **Decision:** (b) **Classic STAS, non-custodial.** The app never holds keys: the wallet derives owner keys (BRC-42, protocol id `[2,'3241645161d8']`) and signs digests (`SIGHASH_ALL|FORKID = 0x41`). Issuance builds the STAS locking script (via `stas-js` helpers) and funds/signs via the issuer's wallet `createAction`; transfers use the **two-transaction storage-agnostic flow** from `stas-knowledge-mcp`. Deps: `@bsv/sdk`, `bsv@^1.5.6`, `stas-js@^3.0.3` (DSTAS via `dxs-bsv-token-sdk` deferred).
- **Consequences:** real STAS (indexer/exchange recognition); non-custodial; **1 sat = 1 token → real BSV locked per issuance** (accepted). Testnet testing **waived** per user (mainnet-only, ADR-003) — covenant risk mitigated by prepare→confirm→broadcast gating + tiny first mints. **TAAL commercial license is a pre-launch business dependency** (flagged, unresolved).

## ADR-022 · Concurrency model: buy-layer DB reservation + operator-sequenced settlement · Accepted · 2026-07-28

- **Context:** BSV has no global mutable state; a "pool balance" is one STAS UTXO, and only one transaction may spend a given UTXO. We must define what happens when buyers act concurrently — two at once, or many. The naive design (each settle resolves the pool UTXO, builds a transfer, broadcasts) races on that single UTXO.
- **Two layers, two answers:**
  - **Buy layer (order placement) — pure DB, no on-chain contention.** Placing an order writes a row; nothing on-chain is spent (the buyer's sats payment is the buyer's own tx). The only hazard is *overselling* the sale allocation. Fixed with an **atomic reservation** in `placeOrder`: a transaction sums tokens already reserved (`pending|settling|settled`) and refuses to cross `allocationForSale`. SQLite serializes writers, so concurrent buys can't both pass the cap. Buys therefore scale freely.
  - **Settle layer (token delivery) — on-chain, single pool UTXO, inherently serial.** Two settles that resolve the same pool UTXO both build valid transfers; the first to broadcast wins, the second is a double-spend the miner rejects with "Missing inputs". This is **safe** (no double-spend, no fund loss, no over-delivery — `markOrderSettled` only fires on an accepted broadcast) but not **live**: the loser must retry against the new pool UTXO.
- **Decision:**
  1. **Atomic buy-layer reservation** (above) — implemented.
  2. **Order-level settlement claim** (`pending → settling`, single conditional UPDATE) — stops a double-click / second tab from burning a redundant funding tx on the same order. Released on failure, finalized on success. Implemented.
  3. **Operator-sequenced settlement** is the model: settlement is processed one-at-a-time per pool, each spending the latest pool UTXO (resolved on-chain by walking the change chain — see STATE/`resolveCurrentPool`). Hops can be **pipelined against unconfirmed change** (BSV imposes no mempool ancestor limit), so throughput is bounded by build/broadcast latency, not block time.
  4. **Batch settlement** is the scale lever: one transfer tx with *N* recipient outputs settles *N* orders in a single pool hop — turning *N* serial hops into one. This is the primary answer to "what if there are many".
  5. **UTXO sharding** (pre-split the pool into *K* parallel UTXOs) is the further lever if a single sequenced/batched worker can't keep up — *K* settlement workers, one per shard, rebalanced periodically.
- **Consequences:** buys are concurrent and cheap; settlement is a serialized/batched backend concern that never risks funds. **Follow-ups:** (a) ✅ *done 2026-07-28* — **reserve-then-pay** implemented: `reserveOrder` (state `reserved`) → pay → `confirmOrderPayment` (`reserved→pending`, re-checks allocation); reservations lazily expire after a 10-min TTL, so an oversold buyer is rejected before paying and abandoned holds free up with no sweep job. (b) a hard browser crash mid-settle leaves an order stuck in `settling` — needs a **stale-lock sweep** (release `settling` older than N minutes); (c) the Postgres migration should replace the sum-in-transaction guard with an atomic `sold` counter (`UPDATE … WHERE sold+n<=cap`) or SERIALIZABLE isolation, since READ COMMITTED could let two aggregates race; (d) **batch settlement** (one tx, N recipient outputs) when volume warrants.

## ADR-023 · Three-role marketplace: platform gates, projects self-serve · Accepted · 2026-07-28

- **Context:** The app had every role collapsed onto the admin — `createProject` hardcoded `ownerId: 'seed-issuer'`, the only auth was the admin-secret, and issuance + pool ownership + settlement all ran from `/admin` behind `isAdmin`. So the admin's wallet signed and paid for everything, and buyers didn't really pay (payment was optional and unverified). The user wants the platform to *only* approve/reject listings; projects should manage their own token.
- **Decision:** Restructure into three roles with real identity, non-custodial throughout (ADR-022 settlement choice):
  - **Platform (admin):** approve/reject listing requests only. `/admin` slimmed to exactly that. Never issues, settles, or holds keys.
  - **Project (issuer):** authenticated by its **BRC-100 wallet identity** (`Account.identityPubkey`), captured at submit (`createProject` now records the real owner + payout address; `SubmitForm` connects the wallet). Self-service dashboard at `/project/[slug]/manage` (owner-gated) where the issuer's own wallet **issues** the token and **settles** its sales — signing and paying itself.
  - **Buyer:** pays the project's payout address; payment is **required and verified on-chain** (`verifyPaymentToAddress`) before the order becomes settle-eligible (reserve-then-pay, ADR-022). Proceeds 100% to the project.
- **Key insight:** the **on-chain wallet signature is the real authority** — only the owner's key can issue or settle their token — so a lightweight DB owner-gate (`isProjectOwner`) is defense-in-depth, not the thing protecting funds. This lets roles ship now without a heavyweight signed-session auth system.
- **Consequences:** the admin does nothing per-project except approve/reject; projects bear their own costs and sign their own transactions; buyers really pay. **Follow-ups:** signed-session auth to harden the DB gate (identity is currently passed from the client, trustworthy only because the wallet signature is the true gate); admin-secret → admin identity allowlist; project-side auto-settle; legacy `seed-issuer` projects aren't owner-manageable (submit fresh ones). Golden rule 3 preserved end-to-end — the platform holds no keys.
