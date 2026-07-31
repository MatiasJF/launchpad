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

## ADR-024 · Genesis issuance: CONTRACT → ISSUE (back-to-genesis authentic) · Accepted · 2026-07-28

- **Context:** Our first live token was flagged **counterfeit** in BSV Desktop. WhatsOnChain's back-to-genesis provenance endpoint (`/token/stas/tx/{txid}/out/{i}/verify`, which the wallet calls) returned `not-authentic / reason: no-genesis`, `failedAt` = the mint itself. Our issuance created a single STAS-shaped output funded by ordinary wallet UTXOs — it had **no contract ancestor**, so the walker found no genesis anchor and every descendant read as fake.
- **Decision:** Issue via the classic STAS **contract → issue** genesis, non-custodially (`packages/bsv/src/issue/genesis.ts`, `issueStasGenesis`):
  1. **Contract tx** — an output `P2PKH(redeem) + OP_RETURN(schema-JSON)` locking the whole supply; `redeemPkh = hash160(redemptionPubkey) = schema.tokenId` is the provenance anchor. Packed with the issue-fee funding output into ONE `createAction` (wallet funds + change).
  2. **Issue tx** — spends the contract output (+ funding) and creates the STAS token output(s) via stas-js `getStasScript`, each carrying that redeem pkh in the script tail. This is the genesis every later transfer traces back to.
  Both txs sign as plain P2PKH (the STAS engine only activates when a STAS output is later SPENT); the wallet derives redeem/owner keys (BRC-42) and signs digests — keys never leave it. The caller broadcasts contract → issue explicitly to WoC (createAction doesn't reliably propagate). `recordIssuance` is no longer admin-gated (the project owner issues, not the platform).
- **Verified offline:** `buildDataOut` emits a **bare `OP_RETURN`** (spendable after `OP_CHECKSIG`), `getStasScript` yields `76a914<owner>88ac69…` with the redeem pkh in the tail, tokenId = `hash160(redemptionPubkey)`. The bsv@1.5.6 script interpreter can't validate the contract spend (it predates Genesis — no `SCRIPT_UTXO_AFTER_GENESIS`; same limitation the working settlement code lives with), so on-chain confirmation is the live test.
- **Consequences:** new mints should verify `authentic` on WoC and render with their real symbol in wallets. Existing pre-ADR-024 tokens (e.g. the first `fdr`) stay counterfeit — reissue. Supersedes the single-output mint path (planMint's script is now preview-only). **Live-test-pending.**

## ADR-025 · Trustless escrow presale via SIGHASH_ANYONECANPAY assurance contract · Accepted · 2026-07-29

- **Context:** L2 escrow presale (soft/hard cap, finalize, refunds) needs to hold contributions trustlessly until the cap is decided, without the platform ever custodying funds (golden rule 3), on mainnet, with classic STAS tokens.
- **Options:** (a) project-held + facilitated refunds (trust-based) · (b) SIGHASH_ANYONECANPAY dominant-assurance contract (Lighthouse/Kickstarter-on-Bitcoin) · (c) sCrypt covenant escrow (funds locked on-chain).
- **Decision:** (b) **ANYONECANPAY dominant-assurance contract** for the soft-cap intake, paired with the existing STAS settlement engine for delivery. Verified against our stack: `@bsv/sdk` builds the `0xC1` (ANYONECANPAY|ALL|FORKID) BIP-143 preimage, the STAS evaluator accepts it, and `wallet.createSignature({hashToDirectlySign})` produces the pledge non-custodially with NO broadcast (must NOT use createAction).
  - **Intake (trustless):** a contributor mints an exact-value UTXO they own and signs it `0xC1` over a fixed soft-cap output to the project. Pledges are held off-chain (a `Pledge` record); funds never leave the contributor. When valid, still-unspent pledges sum to the soft cap, the operator re-validates and assembles them into ONE assurance tx and broadcasts → project funded. If the cap is never met, nothing broadcasts → nothing to refund.
  - **Emergency withdraw (trustless, self-service):** the contributor spends their own pledged UTXO in any normal tx — double-spends the pledge, no operator cooperation.
  - **Above soft cap → hard cap:** ordinary fixed-price instant-swaps (the existing MVP). Assurance handles the all-or-nothing threshold; instant-swap handles the rest. Hard cap + deadline are app-level gates (safe because the contributor is self-custodial throughout).
  - **Delivery (NOT trustless):** classic STAS cannot atomically deliver tokens inside the crowd assurance tx (the token input must sign `0x41` over the whole fixed output set, unknowable while pledges roll in). So post-funding the project distributes STAS via the existing two-tx `transferStas` — operator-signed, the same trust the instant-swap already carries.
- **Consequences:** trustless intake/refund/withdraw with NO new on-chain contract and NO sCrypt toolchain (days, not weeks). The honest limitation is operator-signed **delivery** (mitigated by public pledge registry, SPV-verifiable settlement after the fact, admin gate, reputation). A full sCrypt covenant was rejected: weeks + new toolchain + audit surface, and it still can't atomically deliver tokens. **Key risks (build against these):** pledges must be subset-composable to the exact target — use fixed pledge denominations (overshoot burns to fee); mandatory just-in-time re-validation that every pledged UTXO is still unspent before broadcast (keep a surplus buffer); tx-size ceiling for large crowds → batch into sub-target assurance txs; sighash discipline — pledge input `0xC1`, STAS token input stays `0x41`, never `0x81` (no-FORKID) on BSV.

## ADR-026 · Trustless bonding-curve AMM via OP_PUSH_TX covenant + covenant-native token · Accepted · 2026-07-30

- **Context:** L5 market-making. User chose the full pump.fun AMM (buy AND sell against a reserve) with a **trustless** reserve (sCrypt covenant, not project-held). Non-custodial, mainnet. A stateful covenant is genuinely required here — unlike escrow (ADR-025), a static SIGHASH trick can't enforce buy/sell against an *evolving* reserve.
- **Key findings (grounded):** (1) The OP_PUSH_TX self-referential covenant is **proven live on BSV** — a working example is vendored in `dxs-bsv-token-sdk` (DSTAS locking template: the "sighash-as-signature" trick with generator-point constants + `OP_CHECKSIGVERIFY`, then `OP_HASH256`/`OP_CAT`/`OP_SPLIT`/`OP_NUM2BIN` preimage reconstruction, and an `OP_MUL/OP_DIV/OP_LESSTHANOREQUAL OP_VERIFY` swap-rate tail). Post-Genesis BSV has all needed opcodes + arbitrary-precision integers. (2) The non-custodial signing half is **already in our repo** (`settle/twoTx/p2pkhInput.ts` + ADR-025) — operator assembles, buyer signs only their own input via `createSignature`, covenant self-enforces via the pushed preimage. (3) We have **no sCrypt toolchain** today.
- **Decisions:**
  - **Covenant-native curve token, NOT classic STAS.** Classic STAS is owner-*key*-gated (`CHECKSIG` against an owner pkh); a key-less covenant cannot dispense it without the operator holding the token key = custody. So the AMM covenant is the token ledger during the curve phase; **bridge to classic STAS only at graduation** (mint real STAS to holders, handing off to the proven `genesis.ts`/`settle/` path).
  - **Verify-invariant, not compute-price.** The taker proposes `(Δsats, Δtokens)`; the covenant verifies an inequality that always rounds **against the taker** (buyer pays ≥, seller receives ≤) so truncation can never drain the reserve. MVP curve = **linear `p=k·s`**: `paid ≥ k·Δ·(2s+Δ+1)/2` (the `/2` is exact — division-free enforce path).
  - **State:** `tokens_remaining` (+ nonce) as a trailing data push the covenant reads via `OP_SPLIT` / rewrites via `OP_CAT`; reserve = the UTXO's satoshi balance. Token-units decoupled from sats (STAS's 1-sat=1-token can't apply — reserve and inventory would share an axis).
  - **scrypt-ts as a BUILD-TIME compiler only** (contract → locking-script hex); assemble/unlock with `@bsv/sdk` + `WalletClient.createSignature`, mirroring how we already hand-assemble STAS/DSTAS. Keeps the app thin + non-custodial.
  - **Single hot pool UTXO** → operator-sequenced trades (ADR-022 reservation model); loser re-signs (a `createSignature` round-trip, no custody). Consider a permissionless self-assembly fallback against operator censorship.
  - **Graduation** = a terminal covenant branch (fires when `tokens_remaining==0` or `reserve≥threshold`) paying the reserve to a pre-committed destination + minting classic STAS to holders. BSV has no DEX to graduate *to*, so the target is built here (later phase).
- **Consequences:** the one feature where a stateful covenant earns its keep. **Top risk = audit surface** — a bug in the preimage parse / state rewrite / width-encoding (`OP_NUM2BIN`) / curve inequality is a permanently drainable reserve; external audit required before any non-trivial reserve. **Phased plan:** Phase 0 — toolchain spike (compile a trivial counter OP_PUSH_TX covenant with scrypt-ts, self-replicating spend confirmed on mainnet for ~1 sat — validates/kills the approach in days). Phase 1 — buy-only linear-curve covenant, covenant-native token, operator-sequenced, dust amounts. Phase 2 — sell-back branch (+ external audit). Phase 3 — graduation → mint classic STAS. Mainnet-only (ADR-003) mitigated by dust amounts + prepare→confirm→broadcast gating (ADR-021).

## ADR-027 · Trustless bonding-curve SELL-back via in-covenant ledger (no forgeable token) · Accepted · 2026-07-30

- **Context:** Phase 2 (sell-back) needs the pool's `sold` to decrease by exactly the tokens a seller genuinely holds, trustlessly, with no platform key. User chose fully-trustless.
- **Decisive research finding (spike, grounded in the real DSTAS swap SDK):** a BIP-143 covenant **can** bind a sibling input's *amount* in-script (DSTAS: hand it the counterparty's parent tx, verify against `hashPrevouts`, read the amount), **but cannot verify a token's *authenticity*** — ancestry is not checkable in bounded Script; STAS/DSTAS delegate it to an off-chain back-to-genesis indexer. Critical asymmetry: a forged **STAS** token is inert (worthless fake), but a forged **AMM receipt** sold back **extracts real reserve sats**, and the drain tx is script-valid — an indexer can detect but not prevent it, and anyone (no operator key) can build a sell. **∴ independent receipt UTXOs cannot be both trustless and reserve-safe.**
- **Decision:** Keep holder balances **inside the pool covenant** as a key→amount ledger (Merkle/`HashedMap`). No independent token UTXO exists, so nothing is forgeable — the reserve is drain-proof with **no indexer and no platform key**. A "token holding" is a ledger entry keyed by `ownerPkh`, proven by a **signature** on sell — so there is no receipt covenant at all.
  - **BUY** `buy(delta, newReserve, ownerPkh, oldBal, proof, newRoot)`: enforce curve cost (as ADR-026), credit ledger `ownerPkh += delta` (inclusion+update proof against `root`), successor pool = `{sold+delta, reserve=newReserve, root'}`.
  - **SELL** `sell(amount, ownerPkh, oldBal, proof, newRoot, ownerSig)`: verify `ownerSig` for `ownerPkh` (authorises), prove `oldBal ≥ amount` in ledger, `refund = k·amount·(2·sold − amount + 1)/2` rounded **against the seller**, successor = `{sold−amount, reserve−refund, root'}`, pay `refund` to `ownerPkh`. Pool signs **SIGHASH_ALL** here (must pin both the successor and the payout — ANYONECANPAY|SINGLE is unsafe for sell); a seller-signed fee input covers the miner fee.
- **Trust model:** pure covenant — no indexer, no platform key, drain-proof by construction. This is the only design that literally satisfies "enforced entirely on-chain."
- **Consequences / cost:** the ledger is a Merkle structure maintained in the covenant — the single largest audit surface in the project. Tokens are ledger entries (sell proves a path), NOT wallet-visible UTXOs, until **graduation** (Phase 3) mints real classic STAS to holders from the final ledger. Single hot UTXO → operator-sequenced (ADR-022), loser re-signs. The full ledger is public so anyone can reconstruct proofs. Audit must trace the sell `amount`/`refund` end-to-end to a ledger-bound quantity, re-derive the `/2` exactness for `2·sold − amount + 1`, and scrutinise Merkle/`OP_NUM2BIN` width handling. Feasibility hinges on scrypt-ts `HashedMap` (else a hand-rolled fixed-depth SMT) — validated before build. Buy-only pools already live (ADR-026) are unaffected; ledger pools are a new covenant version.

## ADR-028 · Option B: wallet-held STAS bonding curve, operator-gated (hybrid) · Accepted · 2026-07-31

- **Context:** User chose Option B over the pure-trustless in-covenant ledger (ADR-027): buyers should get a real STAS token in their wallet on buy, and it leaves on sell, with the curve moving. The fundamental result stands — wallet-held tokens + a shared trustless reserve is impossible (a forged token would drain the reserve; authenticity isn't in-script checkable). So sells are OPERATOR-GATED, which matches the project's stated "hybrid, operator-settled" model.
- **Design:**
  - **STAS inventory (pre-mint).** At pool deploy the project mints the FULL curve supply as ONE STAS issuance (reuse `genesis.ts`), held in a project/operator-controlled vault address. Buys transfer STAS out of the vault to the buyer; sells transfer STAS back in. No per-trade genesis. (STAS is owner-key-gated, so the un-sold inventory is necessarily key-held — by the operator/project. This is inventory, not user funds.)
  - **Reserve covenant (curve price).** A small covenant (≈ linear pool, ~1.7KB — NOT the 8.8KB ledger) holds the sats reserve and tracks `sold`. BUY branch: anyone pays `cost` in, `reserve += cost`, `sold += delta` (verify-invariant, no key). SELL branch: pays `refund` to the seller at the curve price AND requires an OPERATOR signature (checkSig) — the gate that stops forged-STAS drains. The covenant caps the payout at the curve refund, so even a malicious operator can't overpay/redirect beyond the curve; it can only authorise or refuse.
  - **Per trade = one operator-cosigned tx.** BUY: `[reserve covenant(buy branch), buyer payment, STAS vault(operator sig)] → [reserve successor, STAS to buyer, STAS change to vault]`. SELL: `[reserve covenant(sell branch, operator cosign), buyer STAS return] → [refund to seller, STAS back to vault]`. Operator sequences (ADR-022) + verifies the returned STAS is genuine (back-to-genesis, ADR-024) before co-signing.
- **Trust model (honest):** trustless *pricing* (covenant caps payouts at the curve) + **operator-gated authenticity/sequencing** (the new trust). The operator holds (1) an authorisation key that co-signs trades and (2) the un-sold STAS inventory key. It CANNOT overpay beyond the curve, but it CAN censor/stall trades, and a compromised operator key could drain the reserve via fake sells — so operator-key security becomes reserve-critical (production-harden it). This **softens ADR-023's "platform holds no keys"** on the curve path — an accepted trade for wallet-held tokens + far cheaper, size-stable transactions (small STAS UTXOs vs the ledger covenant that grows with holders).
- **Consequences:** cheaper + O(1)-in-holders per-trade cost (vs ADR-027's O(holders) covenant growth). Reuses `genesis.ts` (mint), the two-tx STAS transfer + `batchTransferStas` (deliver/return), and the linear-pool covenant math (curve). New: reserve covenant sell-branch operator cosign, the STAS vault, and operator-cosign server signing (a server key — the one genuinely new production concern). The ADR-027 ledger pool stays as the "pure trustless" variant; Option B is a second curve variant. Graduation is unnecessary here (tokens are already wallet-held STAS from buy one).

- **Update (2026-07-31) · operator custody = `@bsv/wallet-toolbox`, not a lean WoC address.** The operator key keeps TWO cleanly-separated roles. (1) **Covenant co-sign** stays a *raw ECDSA signature over the sighash from the flat key* whose `hash160` is baked as `operatorPkh` — it needs only the key, no wallet stack (`apps/web/lib/operator-wallet.ts` `operatorSignDigest`, via bsv-js, unchanged). (2) **Custody** (holds sats/STAS, pays sell-tx fees, broadcasts) now runs on `@bsv/wallet-toolbox` (`operator-toolbox.ts` + `getOperatorWallet`/`operatorBalance`). Rationale: wallet-toolbox is free + open-source and its broadcaster **auto-configures on init — no TAAL/API key** (an earlier "drop wallet-toolbox to avoid TAAL" assumption was wrong). It initializes against `store-us-1.bsvb.tech`/main — the SAME storage `npx fund-metanet` uses — so `fund-metanet --private-key <OPERATOR_KEY hex>` funds the operator directly (coins land at a BRC-42-derived address inside the toolbox basket, tracked via the toolbox, **not** a WoC lookup of the key's base P2PKH address). Verify with `pnpm --filter @launchpad/web operator:balance`. `@bsv/wallet-toolbox` added to `serverExternalPackages` (native `better-sqlite3`).
