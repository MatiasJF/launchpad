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

- **Update (2026-07-31) · Step 1 (deploy + mint) app wiring · deploy and mint are TWO independent signed txs, each a prepare/record split.** `apps/web/lib/stas-service.ts` mirrors `ledger-service.ts` (child-process → CLI `stas-genesis`, scrypt-ts out of Next), exposing `stasGenesisScript(k, supply, operatorPkh)`. `apps/web/lib/stas-actions.ts` mirrors `curve-actions` / `ledger-actions`: **deploy** = `createStasPool` (owner-gated; bakes `getOperator().pkh` into the genesis reserve covenant, upserts the `variant='stas'` CurvePool draft, returns `scriptHex` for the owner wallet to seed with `seedReserveSats`) then `markStasPoolDeployed` (records the deployed UTXO, `status→live`). **Mint** = `prepareStasMint` (owner-gated; builds the mint plan via `planMint` with **owner = `getOperator().pubHex`** so the STAS supply locks to the operator vault's pkh, redemption = the client's wallet-derived anchor pubkey) then `recordStasMint` (persists `Token.issuanceTxid`/`stasTokenId`; does NOT flip sale status — deploy does). `getStasPool(saleId)` reads pool state + the minted-inventory reference. Nothing broadcasts (client signs). Phase-1 params hardcoded `STAS_K=1n`, `STAS_SUPPLY=1000n` (mirrors the ledger variant); the full `supply` is the minted STAS amount. No schema change (CurvePool already carries `variant`/`operatorPkh`/etc; mint txid lives on Token like the instant-buy issuance). **Genesis owner override (root-cause fix, not deferred):** `issueStasGenesis` (`packages/bsv/src/issue/genesis.ts`) gained an optional `ownerPubHex?: string` on `GenesisArgs` — when set, the STAS output locks to `hash160(ownerPubHex)` instead of the wallet-derived `${slug}-owner`; when omitted, behaviour is byte-for-byte identical (the instant-buy path in `IssueButton.tsx` passes nothing → unaffected, verified). The redemption/anchor (tokenId) stays wallet-derived, so provenance and the two-tx CONTRACT→ISSUE structure are unchanged; the admin wallet still funds + signs. `prepareStasMint` returns `ownerPubHex = getOperator().pubHex`, which the client passes as this override so the full supply mints straight into the operator vault; the returned `ownerPkh`/`stasScriptHex`/`tokenId` match what the override produces on-chain (tokenId anchored to the client's `${slug}-redeem`, so the client must issue under the same slug). The only remaining Step-1 deferral is the client UI wiring itself.
- **Update (2026-07-31) · operator custody = `@bsv/wallet-toolbox`, not a lean WoC address.** The operator key keeps TWO cleanly-separated roles. (1) **Covenant co-sign** stays a *raw ECDSA signature over the sighash from the flat key* whose `hash160` is baked as `operatorPkh` — it needs only the key, no wallet stack (`apps/web/lib/operator-wallet.ts` `operatorSignDigest`, via bsv-js, unchanged). (2) **Custody** (holds sats/STAS, pays sell-tx fees, broadcasts) now runs on `@bsv/wallet-toolbox` (`operator-toolbox.ts` + `getOperatorWallet`/`operatorBalance`). Rationale: wallet-toolbox is free + open-source and its broadcaster **auto-configures on init — no TAAL/API key** (an earlier "drop wallet-toolbox to avoid TAAL" assumption was wrong). It initializes against `store-us-1.bsvb.tech`/main — the SAME storage `npx fund-metanet` uses — so `fund-metanet --private-key <OPERATOR_KEY hex>` funds the operator directly (coins land at a BRC-42-derived address inside the toolbox basket, tracked via the toolbox, **not** a WoC lookup of the key's base P2PKH address). Verify with `pnpm --filter @launchpad/web operator:balance`. `@bsv/wallet-toolbox` added to `serverExternalPackages` (native `better-sqlite3`).
- **Update (2026-07-31) · Step 2 (BUY assembly) · the buy is TWO sequenced txs, not one.** The original ADR sketch drew BUY as a single operator-cosigned tx `[reserve buy, buyer payment, STAS vault(operator sig)] → [reserve successor, STAS to buyer, STAS change]`. Building it revealed that a single tx forces the buyer to wait for the operator's vault signature before they can sign their SIGHASH_ALL payment — which breaks the "buying is always open/instant, no key" property the covenant's BUY branch is designed for. **Decision: split the buy into TX-A (buyer-signed reserve buy) + TX-B (operator-signed STAS delivery), sequenced.** TX-A = `[pool covenant BUY input (0xc3, pushes delta,newReserve,preimage + a 1-byte '00' method selector — StasCurvePool is a 2-method contract), buyer payment input (0x41 SIGHASH_ALL)] → [reserve successor @ newReserve]`. It carries **no token receipt** (delivery is TX-B), so it has exactly ONE output; the buyer's SIGHASH_ALL commits that whole output set, the anti-shortchange gate — the operator can neither mis-price (covenant) nor add/divert outputs (buyer sig). Successor derivation is the SAME param-agnostic byte-patch as the linear pool (`poolScriptForSold`; the covenant's only mutable field is `sold`), proven byte-equal to the scrypt-ts `getStateScript` successor in `verify-stas.ts`. Assembly = `packages/curve/src/stasBuyAssembly.ts` (`buildStasBuyTx`), a near-mirror of the proven `buildCurveBuyTx` minus the receipt plus the '00' selector; it validates the assembled covenant input via `validateAssembledCovenantInput` (@bsv/sdk) before returning and broadcasts nothing. Server actions (`apps/web/lib/stas-actions.ts`): `prepareStasBuy` returns the LATEST pool outpoint + exact `curveCost` (the sequencing anchor), `recordStasBuy` mirrors `recordCurveBuy`'s optimistic outpoint guard (advance the pool only if it still sits where the buy spent) — the single serial pool UTXO makes that guard the whole concurrency model, so **no separate DB reservation** (kept faithful to `recordCurveBuy`); the Order is left `pending` (`paymentTxid` = TX-A) because delivery is separate.
- **Update (2026-07-31) · Step 2 · TX-B delivery: custody split + who broadcasts (design choice).** The vault STAS was minted (Step 1) to the operator's **base P2PKH** (owner = operator flat key), while the operator's **fee sats** live in the wallet-toolbox custody wallet — two different signing authorities. `deliverStasToBuyer` (`stas-actions.ts`) → `operatorDeliverStas` (`packages/bsv/src/settle/operatorDeliver.ts`, a faithful mirror of `transferStas`) resolves this by signing each input with its owner: **token input** by the operator flat key (`operatorSignDigest`, raw low-S ECDSA over `sha256sha256(preimage)`, sighash 0x41 — the SAME digest the sell-cosign uses), **fee input** by the toolbox wallet (`createTokenFundingOutput` + `signP2pkhInput`, the exact BRC-29 fee path settlement uses). The operator key never enters `packages/bsv` — it's injected as a `signTokenDigest` callback. The vault UTXO moves after each delivery (token-change re-locks to the operator pkh), so the current vault is **resolved on-chain** by walking the change chain from the mint (`resolveCurrentPool(issuanceTxid)`), the same walk instant-buy settlement uses; ancestry BEEF is fetched from-chain (`getSourceBeef`). **Delivery IS broadcast operator-side** (it's the operator's own tx): TX1 (fee funding) then TX-B via `broadcastRawTx` (WoC) with the "Missing inputs" retry — gated behind explicit invocation of the server action, so nothing fires at import/build/typecheck. The Order is claimed `pending→settling` (double-invoke guard, released on failure) and stamped `settled` + delivery `txid` on success. **Deferred to later steps: SELL (buyer STAS return + operator reserve-refund cosign) and all UI wiring** — this step is buy assembly + delivery only, verified by typecheck/build + the offline covenant test.
- **Update (2026-07-31) · Step 3 (SELL) · the sell is TWO sequenced txs — the atomic single tx is INFEASIBLE with the deployed covenant, not merely undesirable.** The ADR sketch imagined an atomic 3-output sell `[covenant sell (operator cosign), holder STAS input] → [reserve successor, seller refund, STAS to vault]`, with the holder's SIGHASH_ALL committing their own refund so they can't be stiffed. **This cannot validate against the deployed `StasCurvePool.sell()`:** the method is `@method(SigHash.ANYONECANPAY_ALL)` and asserts `ctx.hashOutputs === hash256(poolOut ++ payoutOut)` — i.e. the tx must have EXACTLY two outputs (successor pool + seller refund). A third "STAS to vault" output changes `hashOutputs` and the covenant rejects it; the offline interpreter confirms this. And the holder's STAS input can't ride in that 2-output tx either — its own STAS covenant demands a STAS continuation output the reserve covenant forbids. Changing the covenant (recompile a new artifact) was out of scope and would have broken the verified Step-1/Step-2 deploy scripts, so **decision: a stas sell is TWO sequenced txs**, matching `verify-stas.ts`'s canonical `buildSell` exactly. **TX1 "STAS return"** (holder-signed wallet STAS transfer of `delta` to the operator vault pkh — client, deferred UI). **TX2 "reserve refund"** (operator-cosigned): `packages/curve/src/stasSellAssembly.ts` `buildStasSellRefundTx` builds `[pool covenant SELL input (0xc1 ANYONECANPAY|ALL; unlock pushes delta, payoutScript, operatorPub, operatorSig, preimage then the 1-byte '51' SELL selector — StasCurvePool is 2-method), operator fee input (0x41, consumed WHOLE as the miner fee — no change output is possible since the covenant pins exactly two outputs)] → [reserve successor @ reserveBefore−refund, seller refund P2PKH @ the curve refund]`. The runtime sell unlock encoder `encodeSellUnlockingHex` (curvePool.ts, scrypt-ts-free) is proven **byte-identical to the compiled sell ABI** (`getUnlockingScript(s=>s.sell(...))`) in `verify-stas.ts`, and the assembled covenant input is re-validated in @bsv/sdk (`validateAssembledCovenantInput`) before broadcast. The operator co-signs `sha256sha256(preimage)` with the flat key (`operatorSignDigest`, sighash byte 0xc1), injected as a `signCovenant` callback — the key never enters `packages/curve`. The successor is the same param-agnostic byte-patch as buy (`poolScriptForSold`, proven byte-equal to scrypt-ts for the sell direction). Nothing broadcasts in the assembly module.
- **Update (2026-07-31) · Step 3 · back-to-genesis BEFORE cosign is the anti-forgery rule; the covenant gate exists ONLY for this.** The sell covenant caps the refund AMOUNT + pins the successor (proven: an operator SKIM of the seller refund and a WRONG operator key are both REJECTED by the compiled covenant in @bsv/sdk), but it cannot verify STAS *authenticity* in bounded Script — so a forged token could be sold back to drain real sats. **The operator MUST run back-to-genesis and require `authentic` before co-signing.** There was NO existing B2G helper (ADR-024's "authentic" was a WhatsOnChain explorer observation, not code), so `apps/web/lib/settle-actions.ts` gained `verifyStasBackToGenesis({outpointTxid, outpointVout, issuanceTxid})`: it walks the returned STAS's ancestry hop-by-hop via WoC back to the operator's OWN genesis issue tx (`Token.issuanceTxid`), requiring at every hop a well-formed STAS script whose **token tail** (everything after `76a914<ownerPkh>88ac69` — the tokenId/issuer fingerprint, constant across transfers) equals the genuine mint's tail, and a same-tail STAS parent input, until it lands on the issuance tx (whose parent is the non-STAS contract = the genesis boundary). It is **fail-closed**: any fetch failure, tail mismatch, or ancestry that does not reach our issuance → `authentic:false` → no refund. `findStasOutputToPkh` locates the seller's actual `delta`-token output to the vault in TX1 (so a wrong amount / wrong destination is caught). **Server actions** (`stas-actions.ts`): `prepareStasSell` (sequencing anchor — latest pool outpoint + curve refund preview + the operator vault pkh the holder returns STAS to), `recordStasSell` (creates the `curve_sell` Order `pending`, `paymentTxid` = TX1; does NOT advance the pool — that happens in TX2), `finalizeStasSell` (claims `pending→settling`; finds the returned STAS; runs B2G; builds TX2 against the latest outpoint via the assembly module; broadcasts fee-funding then TX2 with the Missing-inputs retry; advances the pool `sold−=delta`, `reserveSats=reserveAfter`, `poolTxid→successor` under the SAME optimistic outpoint guard as `recordCurveBuy`; stamps the Order `settled` + `refundTxid`). Operator cosign + broadcast fire ONLY inside `finalizeStasSell`. **Ordering / trust (the documented caveat vs. the infeasible atomic form):** the holder returns STAS FIRST, then the operator refunds — so the operator never pays out without receiving genuine inventory. The two added trusts are (a) **liveness** — the operator must be live to broadcast the refund (identical to the Step-2 TX-B delivery trust), and (b) **payee** — the operator supplies output 1, so the refund reaches the seller only because `finalizeStasSell` pays the seller's RECORDED address; the covenant caps the amount but does not cryptographically bind the payee (the atomic form would have, via the holder's SIGHASH_ALL — but the deployed 2-output covenant makes it infeasible). Consistent with the ADR-028 operator-trust model (operator can stall/censor, never overpay or drain the reserve). Verified: bsv+curve+web typecheck, web build, offline covenant tests 10/10 (5 new sell tests). **Deferred: TX1 holder STAS-return wallet assembly + all sell UI + live mainnet test.**
- **Update (2026-07-31) · Step 3 · HARDENED after adversarial review — three real reserve-drain holes fixed.** The first sell cut had three exploitable vulnerabilities; all are now closed + proven (offline tests 17/17 + a DB replay-guard test). **FIX 1 — double-refund replay.** A single on-chain STAS return could back N `curve_sell` orders (no dedup on the returned txid; the 2-output covenant means TX2 does NOT consume the returned STAS UTXO, so nothing on-chain stops re-use): return δ once → spawn N orders → each refunds → drain. **Decision: the RETURNED STAS OUTPOINT is unique sell evidence.** `Order.sellReturnOutpoint` = `${returnTxid}:${vout}` is **@unique** (migration `20260731140000_order_sell_return_outpoint`, also adds `returnVout`), so `recordStasSell` resolves the exact vault-return output on-chain (`findStasOutputToPkh`) and a second order on the same outpoint fails P2002 AT RECORD TIME; `finalizeStasSell` additionally re-checks the return is still UNSPENT on-chain (`isOutputUnspent`) before refunding. One return → one refund. **FIX 2 — back-to-genesis was existence-only, not amount-provenance.** The walk broke on the FIRST same-tail STAS parent and never summed amounts, so an attacker could buy 1 genuine token, fabricate a same-tail COUNTERFEIT output for the rest (mintable from a plain P2PKH with no STAS parent — the ADR-025 forgeable-receipt asymmetry), merge them into a δ-token return, and pass — refunding δ, draining the reserve. **Decision: FULL-provenance authenticity.** The algorithm moved to `packages/curve/src/provenance.ts` (`provenanceWalk`, pure + transport-injected so it is unit-testable offline; `settle-actions.ts` wires WoC fetchers). `genuine(tx)` ⇔ tx IS the issuance, OR (a) EVERY same-tail STAS input of tx is itself `genuine` (no first-match shortcut), (b) tx has ≥1 same-tail STAS input (a same-tail output with none is a fabricated mint → counterfeit), and (c) tx conserves same-tail tokens (Σ same-tail outputs ≤ Σ same-tail inputs — no injected/unbacked tokens). The ancestry is a DAG, so the walk is memoised by txid, BOUNDED by a node budget, and FAIL-CLOSED (any fetch gap, cycle, exceeded budget, tail mismatch, or unbacked ancestry → `authentic:false`; an operator legitimately refuses returns of unverifiably-complex provenance). Proven: full-genuine PASSES, [genuine+counterfeit] merge REJECTED, fabricated-no-parent REJECTED, inflation REJECTED, over-budget FAIL-CLOSED. **FIX 3 — the payee was not covenant-bound; bind it with a SELLER SIGHASH_ALL input (no covenant recompile).** The covenant takes `payoutScript` as an operator ARG and only checks the amount, so a compromised operator could redirect output 1 to itself. **Decision: the SELLER contributes a 0x41 (ALL) fee input to TX2**; the covenant input is 0xc1 (ANYONECANPAY|ALL) so extra inputs are allowed, and the seller's 0x41 signature commits BOTH outputs — locking output 1. New handshake (mirrors the buy's loser-re-signs model): `buildStasSellTx` (SELLER/client) funds + signs the fee input and builds TX2 against a specific pool outpoint, leaving the covenant input empty; `cosignStasSellTx` (OPERATOR) co-signs ONLY the covenant input after the FIX-1/FIX-2 checks; `finalizeStasSell` also re-verifies output 0 == the reserve successor and output 1 == the SELLER's recorded address at the curve refund, and rejects if the covenant input is no longer the latest pool outpoint (the seller re-signs against the new outpoint). Proven: an honest seller-signed TX2 validates BOTH inputs; an operator that redirects output 1 after the seller signs invalidates the seller's 0x41 sig → the fee input REJECTS the tx (even though the covenant branch still passes). **Residual (unchanged, acknowledged):** liveness still rests on the operator broadcasting the refund. [SUPERSEDED — see the next entry: FIX-3's "redirect cryptographically closed" claim was refuted and REVERTED; replay + forgery (FIX-1/FIX-2) remain closed.] All prior invariants retained (amount-cap, B2G-before-cosign ordering, fail-closed, sold-underflow, optimistic sequencing). Green: curve/bsv/web typecheck, web build, offline 17/17, DB replay-guard 1/1.
- **Update (2026-07-31) · Step 3 · FIX-3 (seller-SIGHASH_ALL payee binding) REVERTED — the sell trust model, stated plainly.** Re-verification refuted FIX-3 on two grounds. (1) **Ineffective:** `StasCurvePool.sell()` is `ANYONECANPAY_ALL` and its script requires ONLY the operator's `checkSig` (+ the curve-refund amount + the successor) — it does NOT require the seller's fee input to be present. A party holding the mandatory operator co-sign key simply authors a FRESH 2-output TX2 (successor + a payout to itself) with its own fee input and broadcasts it; the seller's SIGHASH_ALL input and the app-level `out1==seller` / `inputs.length==2` checks are irrelevant to a key-holder. So the payee is NOT cryptographically bound. (2) **Moot:** the only party who can produce ANY valid sell is the operator, and a compromised operator key can already drain the ENTIRE reserve via forged sell-branch spends (no STAS return, no seller involvement) — a redirected refund is a strict SUBSET of the already-accepted "the operator key is reserve-critical" trust (ADR-028). Binding the payee would require a covenant recompile and STILL would not stop reserve drain by a compromised key, so it buys nothing. **Decision: REVERT to the simpler operator-only refund** (`packages/curve/src/stasSellAssembly.ts` `buildStasSellRefundTx`, as at commit 4430549): the OPERATOR funds the fee input, co-signs the covenant input, and sets output-1 = the seller's recorded `receiveAddress` at the curve refund; `finalizeStasSell({orderId})` runs the FIX-1/FIX-2 checks then builds + broadcasts. Removed the seller-signed fee input, the `buildStasSellTx`/`cosignStasSellTx` two-party split, and the app-level payee "binding" checks (they only existed to support FIX-3). The covenant is untouched. **Honest sell trust model (canonical):** the covenant CAPS the refund at the curve price + pins the successor, and — with FIX-1 (unique returned-outpoint dedup + unspent recheck) and FIX-2 (full-provenance back-to-genesis before cosign, fail-closed) — the sell is DRAIN-PROOF against malicious USERS (no oversell, no counterfeit/partly-fabricated STAS, no double-refund). It does NOT cryptographically bind the PAYEE: the operator supplies output-1 and pays the recorded seller address; a COMPROMISED operator key can redirect the refund or drain the reserve — this is the pre-existing, accepted "operator key is reserve-critical" trust, not a new exposure. **KEPT INTACT:** FIX-1 (`Order.sellReturnOutpoint` @unique + `returnVout` + migration `20260731140000_order_sell_return_outpoint`; `recordStasSell` P2002 dedup; `finalizeStasSell` `isOutputUnspent` recheck) and FIX-2 (`provenanceWalk` + `verifyStasBackToGenesis` wiring; B2G runs before cosign, fail-closed). **Added:** a one-line input-outpoint de-dup in `provenanceWalk` (defense-in-depth — a duplicate-outpoint tx can't double-count `inputSats`; non-broadcastable anyway). **Tests:** removed the two FIX-3 payee cases; added "operator-only refund pays output-1 = the recorded address @ curve refund" and "duplicate-outpoint double-count REJECTED". Kept all FIX-1/FIX-2 tests. Green: curve/bsv/web typecheck, web build, offline 17/17, DB replay-guard 1/1.
- **Update (2026-08-01) · Step 4 (UI + client wiring) · two real flow choices.** The backend (steps 1-3) is done; step 4 built the client tx-assembly wiring + the admin/buyer/seller UI so a mainnet round-trip is possible. New components `apps/web/components/StasPoolManage.tsx` (owner deploy+mint) + `StasTradeCard.tsx` (buyer+seller); sale page renders `StasTradeCard` when `sale.type==='bonding_curve'` AND the live pool `variant==='stas'`. Buy wiring: `prepareStasBuy` → `buildStasBuyTx` (buyer funds+signs TX-A) → broadcast → `recordStasBuy` → `deliverStasToBuyer` (operator TX-B), delivered STAS auto-registered into the buyer's wallet. Sell wiring: `prepareStasSell` (now also returns the operator `vaultAddress`) → client `transferStas` of `delta` STAS to the vault (TX1, owner derivation `{keyID: slug, counterparty:'self'}` — the same key buys deliver to) → `recordStasSell` → `finalizeStasSell` (operator refund TX2). All broadcasts live in explicit user-triggered handlers or operator server actions — nothing fires at import/build. **CHOICE 1 — configurable small pool at deploy (replaces the hardcoded supply=1000).** `createStasPool` now accepts `k` + `supply` (default a TINY demo pool: supply=5, k=1; supply capped at 1000). Rationale: the whole `supply` is minted as STAS into the vault and 1 sat = 1 token, so a 1000-supply demo would lock real money and selling out would cost ~500k sats; a tiny pool makes a full mainnet buy+sell round-trip cost only a few hundred sats. The owner sets k/supply/seed in `StasPoolManage`. **CHOICE 2 — the sell's source STAS UTXO is resolved on-chain, not tracked in a basket.** A seller can hold STAS from several buys; the sell card lists the seller's settled `curve_buy` deliveries (`getSellerStasDeliveries`) and, for each (largest first), resolves the CURRENT unspent STAS outpoint by walking change-back-to-holder with the existing `resolveCurrentPool` (a prior partial sell leaves change to the same pkh), then spends the first one that covers `delta` with a from-chain BEEF (`getSourceBeef`) — no wallet-basket dependency, mirroring how the operator's `deliverStasToBuyer` resolves the vault. Limitation (noted): a sell needs ONE holding ≥ `delta` (no cross-UTXO aggregation); the buyer registration in the buy card is a display nicety, not required for selling. Green: web typecheck, web build, verify-stas 17/17 (backend not regressed).
- **Update (2026-08-04) · Step 4 · money-critical `poolScriptForSold` sold=0 / state-int length-boundary fix.** The scrypt-ts-free successor byte-patch (`packages/curve/src/curvePool.ts` `poolScriptForSold`, shared by BUY and SELL) serialized the `sold` @state bigint with the MINIMAL ScriptNum encoder, so `sold=0` produced an EMPTY push. But scrypt-ts's own `getStateScript()` encodes `sold=0` as a single-byte `0x00` push (`… 01 00 …`), NOT empty — so the byte-patched successor for `sold=0` was 1 byte SHORT, its 4-byte `le4` state-body-length field differed, and the covenant's `hashOutputs` assert (buy `re-lock successor` / sell `re-lock + payout`) failed. **Live impact:** any full SELL that lands on `newSold=0` (the pool returning to empty) was rejected at PC 2989 ("top stack element must be truthy") — a real money-critical bug, not cosmetic. Buys/sells to nonzero values were fine (ScriptNum already matches scrypt for 1..1000, including the sign-byte length transitions 127→128, 255→256). **Decision: a dedicated `stateInt()` state-serialization encoder** (0 → `[0x00]`, every nonzero value delegates to the existing `scriptNum` = byte-identical to scrypt). `scriptNum` is left UNTOUCHED because it is also used by the MINIMALDATA unlocking-arg pushes (`pushInt`), where 0 must stay OP_0/empty — the two zero-encodings are genuinely different and must not be conflated. **Verified byte-for-byte** against `getStateScript(s)` for `s ∈ {0,1,2,16,127,128,129,255,256,257,999,1000}`, and a full assembled sell `sold=2→newSold=0` now VALIDATES via `Spend.validate()` (was the PC-2989 reject). **Buys unaffected** — an assembled buy across the 127→128 length boundary validates. `verify-stas.ts` grew 17→33 tests (all green); curve/bsv/web typecheck + web build green.

- **Update (2026-08-04) · Steps 2+3 · money-critical: OPERATOR moved OFF `@bsv/wallet-toolbox` onto a flat-key + WhatsOnChain fee path for ALL trade txs.** **Symptom (live):** under trade load the operator's toolbox custody wallet corrupted — its remote storage (`store-us-1.bsvb.tech`) rejected EVERY `createAction` with "merged Beef failed validation" once the operator held a chain of unconfirmed txs (a delivery per buy, a refund per sell each leave the operator holding un-mined change). Delivery/refund then could not build at all. **Root cause:** the toolbox stores + re-validates the whole wallet BEEF server-side; a growing unconfirmed chain makes that validation fail, and the trade path is *inherently* an unconfirmed chain. **Decision: the operator funds its own tx fees from spendable sats at its own BASE P2PKH address (owner pkh = hash160(operator pubkey) = the same flat key that co-signs the covenant and owns the STAS vault), signed with raw low-S ECDSA over the sighash and broadcast via WoC with the proven multi-pass unconfirmed-chain flush** (the same primitive `operator-fund.mjs` used). This is the path that was ALREADY robust for the STAS token input. **New pure helper** `packages/bsv/src/settle/operatorBaseFunding.ts` (exported as `@launchpad/bsv/settle/base-funding`): `selectOperatorFeeInputs` picks base UTXO(s) covering a needed fee (largest-first, each ancestry-anchored via an injected `fetchBeef`=`getSourceBeefDeep`, unconfirmed-safe since a base UTXO is often prior-op change); `buildOperatorFundingTx` builds a flat-key P2PKH split tx (TX1) that mints an exact-fee output for the sell; `signOperatorP2pkhInput` signs a P2PKH input via a `signFeeDigest` callback. **The operator key stays callback-only** — `operatorBaseFunding` (and `operatorDeliver` / `stasSellAssembly`) receive `signFeeDigest`/`signCovenant`/`signTokenDigest` (all backed by `operatorSignDigest` in `apps/web/lib/operator-wallet.ts`); the key is NEVER imported into `packages/bsv` or `packages/curve`, and WoC I/O (`getOperatorBaseUtxos`, `getSourceBeefDeep`) is injected as callbacks from the app. **Delivery (`operatorDeliverStas`)** dropped its toolbox `feeWallet` + separate TX1 funding output: it now takes `feeInputs`+`baseChangeHash160`+`feeOwnerPubHex`+`signFeeDigest` and assembles ONE tx `[token(flat-key), base fee input(s)(flat-key)] → [recipient token, (token-change to vault), BSV-change to base]` (the STAS engine permits the extra BSV-change output), merging BOTH ancestries (token + each fee input) into the returned atomic BEEF; the app flushes the whole chain via the new shared `broadcastBeefChain`. **Sell refund (`buildStasSellRefundTx`)** kept its two-tx shape because the covenant `sell()` is `ANYONECANPAY_ALL` and pins EXACTLY two outputs (successor pool + seller refund) — NO third change output is possible, so the fee input must be consumed WHOLE as the miner fee. Instead of consuming (and burning) a whole base UTXO, TX1 is now a flat-key `buildOperatorFundingTx` split that mints an exact-fee output at base WITH BSV change back to base; TX2 consumes that output whole. The covenant, `encodeSellUnlockingHex`, the 2-output pinning, and ALL covenant-security asserts are UNTOUCHED — the offline `verify-stas` suite builds its sell tx with a dummy fee input (irrelevant to the covenant under ANYONECANPAY), so it needed NO changes and stays 33/33. **App wiring (`stas-actions.ts`)**: `deliverStasToBuyer` + `finalizeStasSell` stopped calling `getOperatorWallet()`; they select base fee inputs and broadcast via `broadcastBeefChain` (delivery) / funding-chain-then-TX2 (refund). `settle-actions.ts` gained `getOperatorBaseUtxos` (merges WoC confirmed+unconfirmed unspent, drops mempool-spent) + `broadcastBeefChain` (parents-first multi-pass flush of an atomic BEEF's unconfirmed chain). **`@bsv/wallet-toolbox` is DEPRECATED off the trade path** (`operator-toolbox.ts`, `getOperatorWallet`/`operatorBalance` marked `@deprecated`) but kept in-repo, UNUSED by trades — the e2e harness still uses it ONLY for the NON-operator wallet roles (admin mint funding, buyer payment, seller STAS return, which in production are real user/admin wallets). **Harness (`e2e-stas.mjs`)** now drives delivery+refund through the flat-key path and logs `operatorBaseBalance` (WoC sum of base-address UTXOs) at start/end. **Base address `1D86zXnT7hhB7cLYE8NxAd2WZeXqnEcpxF` (pkh `84f96c45…`) is the operator's spendable-sats home.** Green: bsv/curve/web typecheck, web build, verify-stas 33/33, bsv unit 2/2. **NOT yet run on mainnet — the base address is being funded; the maintainer runs the harness once funds land.**
- **Update (2026-08-04) · Step 2 · money-critical delivery robustness (confirmed-BEEF fragility) + buy-side recovery.** **Symptom (live):** a buyer paid — TX-A broadcast, pool advanced to `sold=2` — but the operator STAS delivery (TX-B) FAILED with "could not fetch vault ancestry BEEF (mint may still be confirming)". The buyer paid and got no tokens, with no way to retry. **Root cause:** `deliverStasToBuyer` resolved the current vault UTXO and fetched its ancestry BEEF via `getSourceBeef` → WhatsOnChain `/tx/{txid}/beef`, an endpoint that ONLY returns a BEEF for a CONFIRMED tx (it bundles the merkle proof). A fresh mint — and EVERY subsequent delivery, which re-locks the token change to a NEW unconfirmed vault tx — is unconfirmed, so `/beef` 404'd, `getSourceBeef` returned null, and delivery aborted. This was pure over-restriction: `operatorDeliverStas` hard-requires `source.beef` but uses it ONLY to assemble the buyer's returned atomic SPV BEEF (`mergeBeef`/`mergeTransaction` → `toBinaryAtomic`) — the actual delivery BROADCAST uses the raw tx, so a confirmed-only BEEF requirement blocked delivery needlessly. **FIX 1 — unconfirmed-safe ancestry BEEF (`getSourceBeefDeep` in `apps/web/lib/settle-actions.ts`):** builds a valid ancestry BEEF whose TIP may be unconfirmed. Cheap path: if the tip is confirmed, WoC `/beef` is already a complete bump-anchored proof → use it. Deep path: walk the ancestry from the (unconfirmed) tip — `mergeRawTx` each UNCONFIRMED tx (WoC `/tx/{txid}/hex`, which works for mempool txs), recurse into ALL of its parent inputs, and when a parent is CONFIRMED merge its `/beef` (carrying the merkle BUMP) and STOP that branch (anchored to a mined root). Bounded (visited set + 200-node budget) and FAIL-CLOSED: any fetch gap, an unreachable root within budget, or a BEEF that fails to assemble returns null — never a partial/unanchored BEEF (it is SPV-critical for the buyer). **VERIFIED valid** by round-tripping through `Beef.fromBinary` and requiring `findAtomicTransaction(tip)` to resolve (proves the ancestry is complete + anchored for the unconfirmed tip). `deliverStasToBuyer` now uses `getSourceBeefDeep`, so deliveries work immediately after mint and back-to-back. **API note (faithful choice):** for CONFIRMED ancestors we reuse the existing `/beef` fetch and `Beef.mergeBeef` (same primitive `getSourceBeef`/`operatorDeliverStas` already rely on); for UNCONFIRMED txs we use `Beef.mergeRawTx` — matching @bsv/sdk's documented split (a bump-carrying `/beef` merges whole; a mempool tx merges as raw and is anchored by its parents). No merkle proof is hand-fetched. **Offline check:** `packages/curve/test/deep-beef.test.mjs` reproduces the assembly with synthetic @bsv/sdk txs — an unconfirmed tip spending a `MerklePath.fromCoinbaseTxidAndHeight`-bumped ancestor — and asserts `isValid()`, `Beef.fromBinary` round-trip, and `findAtomicTransaction(tip)`; the exact invariant delivery needs. **FIX 2 — buy-side recovery (mirrors the Step-3b sell recovery, commit fcbd1e4):** `getPendingStasDeliveries(saleId, buyerIdentity)` lists a buyer's `curve_buy` orders `pending`/`settling` with `txid` null (paid, undelivered); `completePendingStasDelivery({orderId, buyerIdentity})` guards buyer ownership + not-yet-delivered, then DELEGATES to the idempotent `deliverStasToBuyer` (which claims `pending→settling` and is `order.txid`-idempotent) — no delivery logic duplicated. `StasTradeCard.tsx` Buy tab surfaces a warning-toned notice ("You paid for N tokens but delivery didn't complete — Complete delivery") + a button, matching the Sell-tab "Complete refund" pattern (same design tokens). **Closes the noted buy-side "no retry" follow-up.** Green: bsv/curve/web typecheck, web build, verify-stas 33/33, curve node suite 19/19.

## ADR-029 · Ship Option B hybrid as the launch curve · ~~atomic~~ SPLIT buy (atomic infeasible with STAS) · defer trustless ledger · Accepted · 2026-08-26

- **⚠️ CORRECTION (2026-08-26, same day) · the "atomic buy" in the original decision below is INFEASIBLE with classic STAS — reverted to the SPLIT buy.** Verified offline BEFORE building the flow (the reason to de-risk assembly first). **Covenant side is fine:** `buy()` is `@method(ANYONECANPAY_SINGLE)` (0xc3), which under BIP-143 commits ONLY its own input + the output at its own index — it tolerates the extra STAS/BSV outputs at any layout (`packages/curve/service/verify-atomic-buy.ts`, **4/4**: both candidate layouts validate; misplaced-successor + underpay REJECTED). **STAS side is the wall:** the classic-STAS token input enforces the **single-change rule** (STAS knowledge base `stas-protocol` + `pitfalls`) — when it commits to the whole output set it accepts only `[token recipient output(s), at most one token-change output, EXACTLY ONE plain P2PKH change]`. The atomic buy tx must ALSO carry the **reserve-covenant successor output** (a ~3.5 KB non-STAS, non-P2PKH script) — a second non-token output the STAS template rejects (`signAction: The top stack element must be truthy`). This is the SAME class of wall that made the SELL two-tx (there the covenant is ANYONECANPAY_ALL pinning exactly 2 outputs; here the STAS token input tolerates only STAS outputs + one P2PKH change). DSTAS shares the rule (no help). **∴ a real STAS token cannot be delivered in the same tx as the reserve-covenant spend.** The covenant's aspirational "delivery rides in the same tx" comment does not hold for classic STAS. **Reverted decision: KEEP the split buy (b)** — TX-A buyer-signed reserve buy + TX-B operator STAS delivery (already built + proven on mainnet, ADR-028 step-2). The "buyer gets the token or nothing" property is NOT achievable in one tx with classic STAS; mitigate the paid-but-undelivered window OPERATIONALLY: robust + monitored delivery, the idempotent self-service **"Complete delivery"** recovery, and operator fee-fuel hardening. A cryptographic atomic swap (buyer payment locked in an escrow covenant released only on operator delivery co-sign) would need a NEW covenant — deferred alongside B-ledger. **The buyer's TX-A SIGHASH_ALL still binds its single output (anti-shortchange); delivery stays covenant-capped + provenance-checked. Go-forward: (1) harden delivery + operator fee-fuel (the real productionization), (2) keep the split buy.** The rest of ADR-029 (ship Option B as the launch curve; sell unchanged; defer B-ledger/batching/auctions; operator-key = load-bearing, HSM-grade custody; honest labelling) STANDS. ↓ original (superseded buy shape) below.


- **Context:** After the strategy synthesis (`docs/research/decentralized-funding-strategy.md`), the user chose the go-forward shape for the bonding curve. The one bounded-Script wall is sell-side back-to-genesis *authenticity* of a wallet-held token, which inherently needs an operator co-sign (ADR-027 asymmetry). Rather than adopt the pure-trustless in-covenant ledger (ADR-027, "B-ledger" — the largest audit surface, and tokens are not wallet-portable until graduation), **ship the hybrid (ADR-028, Option B) as THE launch curve, with real wallet STAS.**
- **Options:** (a) B-ledger trustless sell (ADR-027) · (b) Option B operator-gated sell with **split** buy (ADR-028 step-2: buyer-signed TX-A, operator-delivered TX-B) · (c) Option B with **atomic** operator-cosigned buy.
- **Decision:** **(c).**
  - **BUY = atomic, operator co-signed.** One tx `[pool covenant BUY branch (keyless, 0xc3 preimage) + buyer payment input (0x41 SIGHASH_ALL) + operator vault STAS input(s)] → [reserve successor @ newReserve, STAS → buyer, STAS change → vault, BSV change → operator base]`. The covenant enforces the curve price (keyless, rounds against the taker); the buyer's `0x41` binds the WHOLE output set (anti-shortchange + anti-divert); the operator co-signs the vault STAS input to release the real token. **Buyer receives the token or the tx does not happen — no paid-but-undelivered window.** Trade-off accepted: the operator must be online to co-sign each buy (the operator is in the loop for token movement in BOTH directions). This **replaces** the split TX-A/TX-B buy (ADR-028 step-2) with a symmetric co-sign; prepare → buyer signs payment → operator co-signs vault → broadcast.
  - **SELL = unchanged from ADR-028:** holder signs the STAS return, off-chain **fail-closed** provenance/back-to-genesis (`packages/curve/src/provenance.ts`), operator co-signs; the covenant caps the payout to the curve and pins successor + payout (ANYONECANPAY_ALL, 0xc1).
  - **DEFER (explicit):** B-ledger / HashedMap (ADR-027), batch settlement / batching, Dutch & batch auctions. They stay on the roadmap as the *future* fully-trustless upgrade + viral-scale levers — **not launch blockers** at year-1 scale (20-30 projects × few contributors; one covenant per project already isolates them).
- **Trust model (honest — MUST be labelled in-product):** trustless **pricing** both directions (the covenant caps amounts — nobody can be over/under-paid or diverted); **operator-assisted token movement** both directions (the operator can stall/censor, never mis-price or divert). A **compromised operator co-sign key drains the whole reserve** → the key is the load-bearing security boundary. Label the curve **"instant liquidity — operator-assisted," never "fully trustless."** This makes Option B the DEFAULT launch curve, reversing the strategy doc's positioning of it as a non-default variant; B-ledger becomes the later trustless upgrade.
- **Consequences / build:** new **atomic buy assembly** merging `stasBuyAssembly` (covenant buy) with `operatorDeliver` (STAS transfer) into one tx; the server buy flow reverses so the operator participates at buy time. The split-buy "Complete delivery" recovery is kept ONLY for partial-failure recovery, not the happy path. **Mandatory before real money:** external covenant audit (ADR-026/027), HSM-grade custody for the operator key (or do not ship Option B), robust operator **fee-fuel management** (the mempool jam that blocked local testing), and honest in-product labelling. **Status:** decision only — no code changed yet; implementation to follow via orchestration.

## ADR-030 · Bounded-size ledger: fixed-depth Merkle slots instead of an in-covenant HashedMap · Accepted · 2026-08-26

- **Context.** ADR-027's `LedgerPool` keeps every holder inside the covenant as a `HashedMap`.
  Measured (`packages/curve/service/measure-ledger-size.ts`): the contract code is a fixed 10,884 B
  and each holder adds **~64 B of state**, which appears in BOTH the successor script and the
  sighash preimage — **~128 B per holder per trade**. At 1,000 holders one buy is a **~150 KB**
  transaction. The fee (~22.5k sats) is survivable; the real cost is that reconstruction must
  download every hop, so a client's cost to verify the pool grows as **O(trades × holders)**. This
  is "Limit A" in `docs/TRUSTLESS-LEDGER-ROADMAP.md`, and the reason Option B (ADR-028) exists.
- **Decision.** Commit the ledger as a **32-byte Merkle root** over a **fixed-depth (16) array of
  holder slots**, plus a `holderCount`. A spend carries an inclusion proof of exactly DEPTH sibling
  hashes (**512 B, constant in holder count**). New contract `packages/curve/src/contracts/
  merkleLedgerPool.ts`; off-chain tree `packages/curve/src/merkleLedger.ts`.
- **Why indexed slots, not a key-addressed SMT.** A sparse Merkle tree keyed by a 160-bit pkh needs
  a 160-level path (~5 KB proofs) or a compact bitmap encoding that is markedly harder to verify in
  Script. This is already the largest audit surface in the system, so the simpler structure wins:
  addressing by slot index gives a DEPTH-step verification loop of plain sha256.
- **What it removes.** `LedgerPool.buy` needed an `isNew` flag backed by a **non-membership proof**,
  because `HashedMap.set` could otherwise overwrite a live balance and break `sold == sum(balances)`
  — a reserve drain. Indexed slots close that by construction: every spend must prove the CURRENT
  value of the slot it touches, so nothing can be reset. A new holder proves the slot at exactly
  `holderCount` is EMPTY. A holder ending up with two slots is harmless — the sum is conserved.
  It also removes the **per-spend history replay**: state is three scalars, so no HashedMap has to
  be rebuilt to derive a successor.
- **Measured result.** Locking script **11,865 B at 0 holders and 11,867 B at 200** (the 2 B is
  integer-encoding creep in `sold`/`holderCount` — O(log holders)) versus **23,684 B** for the
  HashedMap at 200. Code floor is ~900 B higher, so the break-even is ~18 holders; above that the
  advantage grows without bound.
- **Consequences.** A second covenant to audit, and pool terms are not interchangeable with
  ADR-027 pools (different script, different genesis). ADR-027's `LedgerPool` stays as the proven
  prototype; deployed ADR-027 pools are unaffected. **Limit B is untouched** — this bounds SIZE,
  not throughput; ~25 trades per confirmation window per pool still stands.
- **Status of proof.** Offline 16/16 through the @bsv/sdk interpreter over the exact assembled
  bytes (`service/verify-merkle-pool.ts`) plus 14 off-chain tree tests, AND the full lifecycle on
  **mainnet 6/6** (`service/verify-merkle-mainnet.ts`, pool `4c6faf97…:0`, k=1 supply=80):
  deploy → append A (`676a7baf…`) → append B (`41056d43…`) → **update A's existing slot**
  (`0ad2a6af…`) → holder-signed sell (`5caf3de5…`) → buy out (`44f2b5dc…`) → graduate
  (`9c5c114d…`, full 3,786-sat reserve released to the committed payout). The locking script
  measured **exactly 11,864 B at every step**, holder count notwithstanding — the ADR's claim,
  on chain.

## ADR-031 · No spread on the trustless curve; attack the fee FLOOR instead · Accepted · 2026-08-27

- **Context.** ADR-030's curve has zero spread: `buyCost(s,d) == sellRefund(s+d,d)` exactly, so the
  pool is precisely solvent, never over-collateralised, and nothing but miner fees discourages wash
  trading. Adding a spread is a covenant change and therefore a re-audit, so the decision had to be
  made before the external audit, not after. Modelled in `packages/curve/service/model-spread.ts`
  against measured numbers rather than argued.
- **Decision: NO spread.** The curve stays exactly symmetric.
- **Why.** Three measured reasons:
  1. **The deterrent already exists.** Every pool spend is ~24.7 KB, so a round trip costs **7,410
     sats** in miner fees at 0.15 sat/B. A 1% spread only becomes the dominant deterrent above
     **~741,000 sats per trade**; below that it is noise next to the chain's own charge.
  2. **The revenue is negligible.** On a realistic pool (k=1, supply=1,000, full raise 500,500
     sats), a **5%** spread on a 30% exit yields **7,508 sats** — two transactions' worth of miner
     fee. At 0.5% it is 751 sats. That does not pay for an audit cycle.
  3. **It costs provable properties.** Today `d·(2s+d+1)` is always even so the `/2` is EXACT, and
     solvency is an equality. A spread makes `refund·(100−f)/100` truncate; the truncation is safe
     (it always favours the pool, and splitting a sell to dodge it costs more in both fee and miner
     fees — verified in the model), but the invariant weakens to `>=` and the auditor gains a
     rounding direction to verify that currently does not exist.
- **What the model surfaced instead — the real problem.** The fee floor is **regressive**: a
  10,000-sat trade pays **74%** in miner fees, a 100,000-sat trade **7.4%**, because every pool
  spend is ~24.7 KB regardless of trade size. ADR-030 bounded the GROWTH; the FLOOR remains
  ~3,705 sats/trade because the ~11.8 KB contract appears twice (successor script + sighash
  preimage). **This curve is uneconomic below roughly 500,000 sats per trade** — a real product
  constraint that had not been stated anywhere.
- **Consequences / follow-up.** Effort goes to the floor, not to a spread:
  1. **Fee-rate calibration — ✅ DONE, rate now 0.01 sat/B.** Measured on mainnet
     (`service/calibrate-fee-rate.ts`): pool-sized (24.7 KB) transactions broadcast at seven
     descending rates were **all seven mined in the same block (964059)** — including **0.001 sat/B,
     i.e. 25 sats for 24,699 bytes**. The rate was deliberately NOT set at that floor: it is one
     sample in one mempool condition, and the failure mode is asymmetric — overpaying costs a few
     hundred satoshis, whereas a pool spend left unconfirmed eats the ~25-deep unconfirmed-chain
     budget every successor shares. **0.01 sat/B keeps a 10x margin over the lowest observed mined
     rate** and still cuts a round trip from **7,410 → 494 sats (15x)**; a 100,000-sat trade now
     pays **0.49%** instead of 7.41%. Confirmed with a real covenant spend, not just the padded
     probes: the full ADR-030 lifecycle re-ran at the new rate on pool `9c4da0cb…:0`
     (deploy → 3 buys → sell → buy-out → graduate `876e6f51…`). Re-probe periodically; a rate that
     works in a quiet mempool can fail in a busy one.
  2. **Batch settlement** — already the Limit B mitigation in `TRUSTLESS-LEDGER-ROADMAP.md`;
     amortises the floor across N buyers, at the cost of a semi-trusted sequencer.
- **Reversibility.** Low cost now, high cost later: adding a spread after the audit means a new
  contract, a re-audit, and pools deployed under the old terms staying on the old script.

## ADR-032 · Enforced graduation delivery via a DELIVERY BOND, not a token-releasing covenant · Proposed · 2026-08-27

- **Context.** ADR-030's curve enforces everything except the last step. Price, custody, refunds and
  the reserve's destination are covenant-enforced; converting final-ledger balances into wallet-held
  STAS after graduation is not. The project ends holding the sats while holders hold ledger entries,
  and nothing on-chain compels delivery. ADR-031's settlement record made that debt public
  (`getProjectSettlementRecord`), which is disclosure, not enforcement. This ADR is about closing it.

- **The constraint that rules out the obvious design.** The natural answer — pre-mint the supply and
  lock it in a covenant that releases `amount` to whoever proves `(pkh, balance)` against the final
  root — is **impossible**. A STAS locking script is
  `76a914 <pkh:20> 88ac 69 …` — literally `OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG`
  followed by the token envelope (`src/provenance.ts`, `isStasScript`/`stasOwnerPkh`, and confirmed
  against every delivery this project has made on mainnet). **STAS ownership is P2PKH: spending
  requires an ECDSA signature from a specific key.** A covenant spends by pushing a sighash preimage,
  not by holding a private key, so **a covenant can never custody STAS.** This belongs beside the
  single-change rule of ADR-029 as a hard property of classic STAS, not a limitation of our design.

- **Decision (proposed): a DELIVERY BOND.** Graduation stops paying the whole reserve to the project.
  It splits:
  - `reserve − bond` → the payout address fixed at deploy (as today)
  - `bond` → a new **DeliveryBond covenant**, parameterised with the final ledger `root`, the
    `totalOwed`, the project's `payoutPkh`, and two block heights.

  Two spend paths, and neither needs to verify a mint:
  1. **Holder claim, after `claimHeight`.** Any holder proves `(pkh, balance)` against `root` — the
     same inclusion-proof machinery ADR-030 already has — and takes `bond × balance / totalOwed`.
     Claims are tracked in the bond's own Merkle ledger so a slot cannot be claimed twice.
  2. **Project reclaim, after `reclaimHeight` (> `claimHeight`).** The project takes whatever is
     left.

  So: deliver on time and holders have no reason to claim, and the project recovers the bond.
  Fail to deliver and the holders drain it. **The holder's decision to claim IS the signal**, which
  is exactly why no proof-of-mint is needed.

- **This is ECONOMIC enforcement, not cryptographic delivery.** A project can still choose to forfeit
  the bond and never mint. What changes is that non-delivery now costs it, and the compensation flows
  to precisely the holders who were stiffed. That is strictly stronger than ADR-031's disclosure and
  strictly weaker than the covenant guarantees preceding it, and the UI must say so in those terms.

- **Known weakness — double-dipping.** A holder who *was* delivered tokens can still claim the bond
  after `claimHeight`. Preventing it would require the covenant to verify a STAS mint, which the
  constraint above forbids. Mitigations, in order of preference:
  1. Size the bond as partial compensation (10–25% of reserve), so double-dipping is bounded and the
     tokens are worth more than the claim to anyone who believes in the project.
  2. Set `claimHeight` far enough out that an honest project has delivered first; claims are public,
     so a double-dipper is visible.
  3. Publish claims alongside the settlement record, so the project mints only to non-claimers.
  None of these is airtight. **This is the main open question and should be settled before building.**

- **Alternatives rejected.**
  - *Covenant holds pre-minted STAS.* Impossible — see the constraint.
  - *Escrow released on proof-of-mint.* Requires verifying a STAS output's shape AND ownership AND
    that it corresponds to a specific ledger entry, per holder, in Script. Enormous audit surface for
    a check the single-change rule may make unconstructible anyway.
  - *Burn the bond on non-delivery.* Punishes the project without compensating holders; strictly
    worse than paying them.
  - *Abandon graduation; the ledger IS the token.* Coherent, and worth revisiting — holders can
    already sell back at the curve. It gives up portability, which was graduation's entire purpose.

- **Consequences.** A second covenant to design, compile, test and AUDIT — comparable in size to
  ADR-030 itself. ~~It changes the graduation path, so it must land BEFORE an external audit rather
  than after.~~ Graduation becomes a 2-output spend (payout + bond), which the covenant must pin.
  Existing graduated pools are unaffected and keep the ADR-031 disclosure only.

  **Correction, 2026-08-28 — the sequencing claim above was wrong, and it was load-bearing.** It
  would have held the external audit behind weeks of work. `graduate()` is **4 lines of 209**; ADR-032
  rewrites those and adds a SEPARATE bond covenant. It does not touch `buy()`, `sell()` or the Merkle
  slot machinery — and all seven drain vectors in the review brief live there. So an audit of the
  current covenant transfers almost entirely, and the bond needs its own review regardless, being a
  new contract. **The audit goes first.** The reviewer's opinion on whether the bond is worth building
  at all is then an INPUT to this decision rather than something we settle alone, which is the better
  use of an outside expert given the double-dip question below has no airtight answer.

- **Status: PROPOSED, not accepted.** The double-dip question above is unresolved, and the honest
  alternative — accept disclosure-only and put the effort into the external audit instead — has not
  been ruled out. Recorded now so the design is not re-derived, and so a decision is made before the
  audit rather than after it.

---

## ADR-033 · A pledge is a STANDING authorisation, so withdrawal is a first-class control · Accepted · 2026-08-31

- **Context.** ADR-025 shipped the escrow presale in July and it sat "built, live-test pending" for a
  month. Taking it to mainnet (`pnpm --filter @launchpad/web e2e:presale`) meant first asking what the
  design actually guarantees. Two answers came back different from what the code and UI claimed.

- **Finding 1 — the pledge signature never expires and is not conditional on the cap.** Under
  `ANYONECANPAY | ALL`, a contributor commits to their own input and to the fixed output
  `[softCap → payoutAddress]`. Nothing binds the other contributors, and nothing binds a deadline.
  Verified by counterfactual: one 1,000-sat pledge plus an unrelated 2,100-sat input paying 3,000 to
  the project **verifies**. So "your sats cannot move unless the soft cap is met" was wrong. The true
  guarantee is narrower and still valuable: **the sats can only ever go to the project's payout
  address.** It is a destination guarantee, not a threshold guarantee. Anyone holding the stored
  signature can complete the spend at any time by funding the difference themselves.

- **Finding 2 — the contributor could not perform the withdrawal we told them to perform.**
  `createTokenFundingOutput` created the pledge UTXO with no basket, which wallet-toolbox records as
  `basketId: undefined, change: false`. `listOutputs` requires a basket and filters on `basketId`, so
  the coin was **not enumerable**; `change: false` meant it was never selected; and the wallet will not
  sign a caller-supplied input during `signAction` (the reason `signP2pkhInput` exists at
  `p2pkhInput.ts:5-7`). `ContributeCard` said *"To withdraw, just spend that coin"* — an instruction
  no contributor could follow. Funds were never at risk (the key derives from their own master key),
  but recovery required tooling that did not exist.

  Together these compound: **spending the coin is the contributor's only way to revoke a standing
  authorisation, and that was the one thing that did not work.**

- **Decision.** Withdrawal becomes a supported operation rather than a documented intention.
  1. Pledge outputs go in a **dedicated basket** (`PLEDGE_BASKET = 'launchpad-pledge'`) so the owner's
     wallet can enumerate them. Deliberately **not** `default` — the wallet draws change from
     `default` and could spend a pledge out from under a live signature. `createTokenFundingOutput`
     now refuses `default` outright.
  2. `withdrawPledge()` builds and signs the reclaim from the contributor's own derivation, and
     `ContributeCard` exposes it as a per-pledge **Withdraw** button. Non-custodial throughout: the
     contributor's wallet signs, no operator key is involved, and the funds can go nowhere but their
     own address.
  3. `reconcileWithdrawnPledges()` flips spent pledges to `withdrawn` before any decision that depends
     on how much is really pledged. Previously nothing ever wrote that state, so one withdrawal
     **deadlocked a presale**: `recordPledge` still counted the coin and rejected replacements ("the
     soft cap is fully pledged") while `getPledgesForAssembly` checked the chain and could never reach
     the cap — and the public page advertised a raise that no longer existed.

- **Also closed in this pass** (each found by adversarial review, each verified):
  - `recordPledge` was unauthenticated and could not distinguish a **nonexistent** outpoint from an
    unspent one — WoC answers 404 for both — so `{real txid, vout: 99}` was accepted, occupied
    soft-cap space, and killed assembly with no way to invalidate the row. It now checks the outpoint
    on-chain, requires the script to be P2PKH to the pledging key, and **verifies the 0xC1 signature
    against the reconstructed template** before the pledge is worth a slot.
  - `Pledge` gains `@@unique([txid, vout])`. Legacy `bsv`'s `.from()` silently *drops* a duplicate
    outpoint, which misaligned every unlocking script after it — failing only after the fee UTXO had
    been minted and spent.
  - `markAssemblyBroadcast` now filters on `state: 'pledged'`. A replayed call created a second Order
    per pledge (measured: 4 orders for 2 pledges), doubling the tokens owed against sats collected.
  - `updateSaleEscrow` refuses to change presale terms once anyone has pledged. Lowering `softCap`
    afterwards produced an assurance tx that assembled cleanly, reported `ok`, and was rejected by
    every node, because the signatures committed to the old value.
  - `updateSaleEscrow` also refuses a pledge unit that is not a multiple of the price. A pledge buys
    `floor(unit / price)` tokens, so any remainder was value paid and never delivered, on every pledge.
  - The assurance fee estimate's overhead constant goes 40 → **44 bytes** (measured: 4 version + 1
    inCount + 1 outCount + 34 output + 4 nLockTime). There is no change output to absorb an
    underestimate, so it must never come in under the truth.

- **Consequences.** The presale's trust story is now stated accurately: funds are self-custodial, the
  destination is fixed by signature, and the contributor can revoke at will — the last of which is
  true because we built the control, not because the wallet happened to offer it. Proven end-to-end on
  mainnet 2026-08-31; the assurance tx paid 40 sats on 486 bytes (**0.0823 sat/B**) with exactly one
  output, and a withdrawn pledge was correctly excluded from assembly while a replacement took its
  slot. Txids in `docs/mainnet-runs/presale-2026-08-31T09-59-00-987Z.jsonl`.

- **Still open.** The dedicated basket is correct by construction but **unverified in BSV Desktop** —
  the harness's `FlatKeyWallet.listOutputs` is a shim that ignores the basket argument, so this run
  proved the coin is *spendable* (via `withdrawPledge`), not that a real wallet *displays* it. That
  needs a device test before we claim native visibility.
