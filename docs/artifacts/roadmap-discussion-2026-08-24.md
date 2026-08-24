# Roadmap Discussion — 2026-08-24

**Context**: After completing the pre-mortem audit fixes (UTXO spent-check enforcement, mempool depth guard) and designing comprehensive UX/UI mockups, this document synthesizes the current state, articulates the vision, and frames the key strategic decisions ahead.

**Read this to**: Understand what's built, what's possible, what trade-offs exist, and what sequence makes sense.

---

## I. What We Have — Current State

### Built & Verified (Green)

#### P3 · L0 Instant Swap — **COMPLETE** ✅
- **Fixed-price STAS tokens on mainnet**
  - Admin-gated project creation + approval
  - BRC-100 wallet connection (BSV Desktop)
  - Classic STAS issuance (CONTRACT → ISSUE, back-to-genesis authentic)
  - Reserve-then-pay flow (atomic allocation check, no overselling)
  - Operator-sequenced settlement (no UTXO contention)
  - SPV-verified delivery (BEEF ancestry proofs)
  - On-chain payment verification
  - `Order` + trade history recorded

- **Three-role marketplace** (ADR-023)
  - **Platform/Admin**: Approve/reject only (never holds keys)
  - **Project/Issuer**: Self-service issuance + settlement via own wallet
  - **Buyer**: Pays project payout address, receives STAS in wallet

- **Non-custodial throughout** (Golden Rule 3 preserved)
  - No private keys ever handled by platform
  - All signing happens in user's wallet (BRC-100)
  - Operator holds un-sold inventory (not user funds)

#### ADR-028 · STAS Bonding Curve — **COMPLETE** ✅
- **Hybrid trustless pricing + operator-gated settlement**
  - Linear curve `p = k·s` with verify-invariant covenant
  - BUY: Trustless (covenant enforces price, anyone can buy)
  - SELL: Operator-gated (covenant caps refund, operator verifies authenticity)
  - Wallet-held STAS tokens (not ledger entries)
  - Back-to-genesis authenticity check before sell (fail-closed)

- **Money-critical fixes (2026-08-04)**
  - FIX 1: Double-refund replay closed (`Order.sellReturnOutpoint` unique)
  - FIX 2: Full-provenance authenticity (no counterfeit/fabricated STAS)
  - Operator off toolbox → flat-key + WoC (robust under trade load)
  - Unconfirmed-safe BEEF delivery (`getSourceBeefDeep`)
  - Buy-side + sell-side recovery (pending delivery/refund retry)

- **Live on mainnet** (small pools tested, full round-trip proven)

#### Latest Pre-Mortem Fixes (2026-08-24) — **COMPLETE** ✅
- **FIX 1**: UTXO spent-check enforcement at package boundary
  - Required `fetchIsUnspent` callback in `selectOperatorFeeInputs`
  - Fail-closed: skips already-spent UTXOs (no double-spend risk)

- **FIX 2**: Mempool depth fail-before-broadcast guard
  - Optional `fetchUnconfirmedDepth` callback
  - Explicit failure if ALL UTXOs are too deep (> 10 ancestors)
  - Prevents "too-long-mempool-chain" broadcast rejection

- **All tests green**: 22/22 package tests pass, typecheck clean

### What Works Right Now

1. **Admin can approve projects** (`/admin`)
2. **Projects can issue STAS tokens** (own wallet, mainnet)
3. **Buyers can purchase fixed-price** (instant swap, SPV-verified)
4. **Buyers can trade on bonding curves** (BUY immediate, SELL operator-gated)
5. **All transactions are mainnet, real sats, SPV-verifiable**
6. **No custody at any layer** (admin, project, platform all non-custodial)

---

## II. What We Designed — UX Vision

### The 5-Screen Redesign (2026-08-24)

Comprehensive UX mockups created with BSV's technical constraints mapped to UX opportunities:

1. **Landing/Discovery Page**
   - Live / Trending / Completed tabs
   - Stats strip (Total Raised, Active Launches, Projects)
   - Live status indicators
   - ProjectCard grid (already exists)

2. **Project Detail Page**
   - Buy / About / Stats tabs
   - Price guarantee messaging ("no slippage, no front-running")
   - Recent activity feed
   - Rich-text project description
   - Aggregate stats (buyers, distribution, volume)

3. **Buy Flow Modal** (multi-step)
   - Wallet Connect → Amount Input → Confirm → Processing → Success
   - Real-time BSV cost calculation
   - Breakdown display (You pay X → You get Y)
   - SPV proof auto-download on success

4. **Post-Purchase Success Screen**
   - Trade summary with delivery txid
   - SPV proof download button
   - "What is SPV?" explainer
   - Next actions (View Portfolio, Share, Back to Project)

5. **Portfolio / Trade History**
   - Holdings / Activity / Stats tabs
   - Grouped by project (current tokens held)
   - Chronological trade history
   - Aggregate analytics (total spent, tokens held, projects)
   - WhatsOnChain explorer links

### Component Mapping Complete

**Documented in**: `docs/artifacts/ux-component-mapping.md`

- ✅ What exists in codebase (ProjectCard, ProjectDetail, buyProjectTokens, etc.)
- ❌ What's missing (12 new components, 5 utility modules, 1 route)
- 📍 Exact build locations for each screen
- 📋 Recommended build order (Landing → Project Detail → Buy Modal → Portfolio)

### Key UX Insight

**Tech constraints → UX opportunities**: BSV's instant finality, no global state, and SPV verification aren't limitations to hide — they're features to showcase:

- **Instant finality** = "Your tokens are yours the moment the tx confirms (seconds)"
- **No front-running** = "Price locks when you confirm — no MEV, no slippage"
- **SPV proof** = "Download proof your trade happened — portable, verifiable, permanent"
- **Operator-sequenced** = "Trades execute in order — fair, transparent, no race conditions"

---

## III. What's Possible — The Vision Map

### Current Position: P3 Complete

We've completed the **honest loop** — the one critical path that proves the model works:
- Project issues → Buyer buys → Tokens delivered → SPV verified → On-chain permanent

### The Roadmap Phases (from ROADMAP.md + DECISIONS.md)

#### P0 · Foundation — ✅ DONE
- Repo scaffold, knowledge base, entity schema
- Fully documented (3-file cold start)

#### P1 · Wallet + Read Path — ✅ DONE
- BRC-100 wallet connection (BSV Desktop)
- Public browse of projects
- Design system foundations

#### P2 · Admin-Gated Issuance — ✅ DONE
- Auth gate + admin approval
- STAS issuance on mainnet (CONTRACT → ISSUE genesis)
- Public allocation split into sale-pool UTXOs

#### P3 · L0 Instant Swap — ✅ MVP COMPLETE
- Fixed-price buy (operator-sequenced, SPV-verified)
- Order + Event recording
- The honest loop proven end-to-end

#### P4+ · The Layers — **FUTURE**

**From ROADMAP.md:**
- **L1**: Project surface (dashboards, metrics, docs)
- **L2**: Escrow presale (soft/hard cap, finalize, refunds, emergency withdraw)
- **L3**: Identity & allocation (tiers, KYC)
- **L4**: Distribution (vesting UI, airdrops)
- **L5**: Rewards & market (staking → bonding curves → farms → vaults)

**Bonding curves already live** (ADR-028), so we've jumped ahead on L5 Market.

---

## IV. Strategic Decisions — What to Prioritize

### Decision 1: UX First or Features First?

**Two paths forward:**

#### Path A: Ship the UX Redesign
- Implement the 5-screen mockups (Landing → Project Detail → Buy Modal → Portfolio)
- Polish the existing fixed-price + curve flows
- Make what we have **feel** professional and credible
- **Outcome**: Better first impression, easier user testing, stronger demo

**Effort**:
- High-impact, low-effort wins (Landing tabs, stats) = 1-2 days
- Buy Modal (core UX) = 3-4 days
- Portfolio page = 2-3 days
- **Total**: ~1 week for substantial UX improvement

#### Path B: Add More Mechanisms
- Escrow presales (ADR-025 ANYONECANPAY assurance contract)
- Ledger-based curves (ADR-027 in-covenant balances)
- Project dashboards (L1)
- Staking / farms (L5 next steps)
- **Outcome**: More feature breadth, more demo scenarios

**Effort**:
- Escrow presale = 1-2 weeks (contract + intake + finalize flows)
- Ledger curves = 2-3 weeks (audit-critical, scrypt-ts `HashedMap`)
- Project dashboards = 1 week
- **Total**: Months for substantial feature expansion

### Recommendation: **Path A (UX First)**

**Rationale:**
1. **We already have the core value prop** — real STAS on mainnet, both fixed-price and curves
2. **UX is the bigger gap** — the tech works, but the UI doesn't showcase it well
3. **Easier user testing** — can't test adoption without a usable interface
4. **Faster time-to-demo** — polished UX makes what we have look production-ready
5. **Build backward from UX** — user quote: "sometimes it's better to make the ux/ui a great thing having in mind the tech limits and then build backwards to the technology"

**The honest insight**: More mechanisms don't help if users can't understand the ones we have.

---

### Decision 2: Which Curve Model to Default?

**Three variants built/designed:**

1. **Linear STAS Curve** (ADR-028, **LIVE NOW**)
   - Wallet-held tokens (real STAS UTXOs)
   - Trustless buy, operator-gated sell
   - Small covenant (~1.7 KB)
   - Proven on mainnet

2. **Ledger Curve** (ADR-027, designed but not built)
   - In-covenant balances (Merkle/`HashedMap`)
   - Fully trustless (no operator key)
   - Larger covenant (~8.8 KB, grows with holders)
   - Audit-critical (Merkle + OP_NUM2BIN width handling)

3. **Fixed-Price Instant Swap** (original P3, **LIVE NOW**)
   - No curve, simple allocation split
   - Operator-sequenced
   - Battle-tested

**Current UX mockups assume**: The existing STAS curve (wallet-held tokens, operator-gated sell)

### Recommendation: **Keep STAS Curve as Default**

**Rationale:**
1. **It's already live** — no build, just UI polish
2. **Wallet-held tokens** — better UX (visible in wallet, familiar)
3. **Cheaper transactions** — O(1) size vs O(holders) growth
4. **Lower audit surface** — small covenant, no Merkle complexity
5. **Operator trust is acceptable** — matches the stated "hybrid, operator-settled" model (ADR-001)

**Ledger curve stays as the "pure trustless" variant** for projects that want zero operator trust — a premium offering, not the default.

---

### Decision 3: What About Escrow Presales?

**ADR-025 designed it**: ANYONECANPAY dominant-assurance contract (Lighthouse/Kickstarter-on-Bitcoin)

**The model:**
- Contributors pledge UTXOs (signed 0xC1 over a soft-cap output) — off-chain, no broadcast
- When pledges sum to soft cap, operator assembles + broadcasts → project funded
- If cap never met, nothing broadcasts → nothing to refund (trustless intake)
- Emergency withdraw = contributor spends their own pledged UTXO (double-spend, self-service)
- Delivery still operator-signed STAS transfer (not atomic)

**Trade-off**: Trustless **intake** (the all-or-nothing threshold), but operator-signed **delivery** (same trust the instant-swap carries).

**Status**: Designed, not built.

### Recommendation: **Defer Escrow to Post-UX**

**Rationale:**
1. **Fixed-price instant swap already works** — escrow is a threshold variant of the same primitive
2. **UX redesign doesn't depend on it** — the Buy Modal works for instant or escrow
3. **Complexity vs. value** — escrow adds intake complexity for a use case we haven't validated demand for yet
4. **Can build later** — ADR-025 is fully specified, just not implemented

**Ship the UX first, validate user demand, then decide if escrow is worth building.**

---

### Decision 4: What Balance Between "Offering Engine" and "Full DEX"?

**ADR-002 scoped us as "offering engine"** — fixed-price issuance + sale + panel + admin curation, ~80% of value at ~40% of difficulty.

**We've already expanded beyond that:**
- Bonding curves (L5 market-making, ADR-028)
- Self-service project management (ADR-023)
- Non-custodial end-to-end (Golden Rule 3)

**The unbuilt layers (L1-L5) are huge:**
- Project dashboards (metrics, analytics)
- Escrow presales (soft/hard cap, refunds)
- Identity & allocation (tiers, KYC)
- Vesting + airdrops
- Staking, farms, vaults

**Current tension**: Do we stay narrow (offering engine + curves, super polished) or go broad (many mechanisms, rougher UX)?

### Recommendation: **Narrow + Polished**

**Rationale:**
1. **The moat is execution, not features** — anyone can copy mechanisms, but polished UX + trust + live mainnet track record is hard
2. **BSV is credibility-starved** — a single high-quality product > many half-baked ones
3. **Easier to test** — narrow scope = tighter feedback loops
4. **Build on success** — ship polished instant-swap + curve, validate adoption, then expand

**The honest product strategy**: Be the **best** STAS launchpad, not the **most feature-rich**.

---

## V. Recommended Roadmap — Next 4 Weeks

### Week 1: UX Foundation (High-Impact Wins)
**Goal**: Make what we have look production-ready

1. **Landing Page Enhancements** (2 days)
   - Add Live / Trending / Completed tabs (filter existing ProjectCard grid)
   - Add stats strip (Total Raised, Active Launches, Total Projects)
   - Add live status pills to project cards
   - **Deliverable**: Landing page feels like a real marketplace

2. **Project Detail Tabs** (2 days)
   - Add Buy / About / Stats tabs (client-side switcher)
   - Extract existing Buy content into Buy tab
   - Add About tab (render `project.description`, add `longDescription` field to schema)
   - Add basic Stats tab (query + stat cards, defer charts)
   - **Deliverable**: Project pages have structure + context

3. **Price Guarantee Messaging** (1 day)
   - Add explicit "Price locks when you confirm—no slippage, no front-running" callout to Buy tab
   - Add "What is SPV?" explainer (collapsible)
   - **Deliverable**: BSV's unique value props are visible

**End of Week 1**: Landing + Project Detail polished, tech advantages surfaced

---

### Week 2: Buy Flow (Core UX)
**Goal**: Turn the buy action into a guided multi-step flow

1. **Buy Modal Component** (3 days)
   - Build multi-step modal (`buy-modal.tsx`, client component with state machine)
   - Steps: Wallet Connect → Amount Input → Confirm → Processing → Success
   - Amount Input: real-time BSV cost calculation, max affordable hint
   - Confirm: breakdown display ("You pay X BSV → You get Y tokens")
   - Processing: spinner + status ("Broadcasting... Delivering... Verifying...")
   - Success: trade summary + SPV proof auto-download + next actions

2. **SPV Proof Download** (1 day)
   - `download-beef.ts` utility (BEEF `number[]` → browser download as `.beef` file)
   - Trigger on success step
   - **Deliverable**: Users get portable proof they can verify independently

**End of Week 2**: Buy flow is guided, clear, and showcases instant finality + SPV

---

### Week 3: Portfolio + Activity
**Goal**: Users can see their holdings and trade history

1. **Portfolio Page Route** (2 days)
   - Create `/portfolio` route (`apps/web/app/portfolio/page.tsx`)
   - Add Holdings / Activity / Stats tabs (client wrapper)
   - Holdings tab: Group trades by project, show total tokens per project, current value estimate
   - Activity tab: Chronological trade history (date, project, amount, cost, delivery txid link)

2. **Portfolio Queries** (1 day)
   - `portfolio-queries.ts`: `getPortfolioHoldings`, `getUserTrades`, `getPortfolioStats`
   - Aggregate queries on `Trade` model
   - **Deliverable**: Users can track their positions

3. **WhatsOnChain Links** (1 day)
   - `woc-link.ts` utility (txid → `https://whatsonchain.com/tx/${txid}`)
   - Link every delivery txid in Activity tab
   - **Deliverable**: Users can verify on-chain independently

**End of Week 3**: Portfolio page complete, users can track + verify their trades

---

### Week 4: Polish + Testing
**Goal**: Fix rough edges, test end-to-end, prep for user feedback

1. **Visual Polish** (2 days)
   - Consistent spacing, typography, colors across all screens
   - Dark theme refinement (per ADR-017)
   - Loading states + error handling
   - Empty states (no projects, no holdings)

2. **End-to-End Testing** (2 days)
   - Full buy flow (wallet connect → purchase → delivery → portfolio)
   - Full sell flow (curve sell → refund → portfolio update)
   - Admin approval flow
   - Project issuance flow

3. **Documentation** (1 day)
   - Update STATE.md (reflect new UX)
   - Update INDEX.md (new components, routes)
   - Screen recordings / walkthrough for demo

**End of Week 4**: Polished, tested, ready for user feedback or demo

---

## VI. Open Questions for User

### Question 1: UX-First Path — Confirm Priority?
**Do you agree UX redesign should come before new mechanisms (escrow, ledger curves, staking)?**

- ✅ Yes → Proceed with 4-week UX roadmap above
- ❌ No → Which mechanism should we prioritize instead?

---

### Question 2: Curve Model — Confirm Default?
**Should the STAS curve (wallet-held tokens, operator-gated sell) be the default curve offering?**

- ✅ Yes → Keep it as-is, polish the UI
- ❌ No → Build ledger curve first (fully trustless, audit-critical, 2-3 weeks)

---

### Question 3: Escrow Presales — Build Now or Defer?
**ADR-025 designed trustless intake (ANYONECANPAY assurance contract). Build it now or wait?**

- 🔜 Build now → Add to roadmap (1-2 weeks, before or after UX?)
- ⏸️ Defer → Ship UX first, validate demand, build escrow later
- ❌ Don't build → Drop escrow entirely (instant-swap + curves are enough)

---

### Question 4: Scope — Stay Narrow or Go Broad?
**ADR-002 scoped us as "offering engine" (issuance + sale). We've added curves. Keep expanding or polish what we have?**

- 🎯 **Narrow + polished** → Best STAS launchpad (instant + curves), super tight UX
- 🌐 **Broad + rougher** → Many mechanisms (escrow, staking, farms), less polish per feature

---

### Question 5: Target Launch Date?
**When do you want this in front of real users?**

- 📅 4 weeks (end of Sept) → UX roadmap above fits, feature-freeze after polish
- 📅 8 weeks (end of Oct) → Room for UX + 1-2 new mechanisms (escrow or project dashboards)
- 📅 No deadline → Build until it feels right

---

## VII. The Honest Position

### What We've Built is Rare

**Few projects can claim:**
1. ✅ **Real tokens on mainnet** (not testnet, not vaporware)
2. ✅ **Non-custodial end-to-end** (no keys held, ever)
3. ✅ **SPV-verifiable** (portable proofs, independently checkable)
4. ✅ **Trustless pricing** (covenant-enforced curves, no operator can overpay)
5. ✅ **Battle-tested** (survived trade load, fixed money-critical bugs, still standing)

**The tech works.** The UX doesn't showcase it yet.

---

### What Users Will Actually Care About

Not the covenant math or the BEEF ancestry or the BRC-42 key derivation.

**They'll care about:**
1. **Can I buy tokens easily?** (Buy Modal answers this)
2. **Are my tokens actually mine?** (Wallet-held STAS + SPV proof answers this)
3. **Can I see my portfolio?** (Portfolio page answers this)
4. **Can I trust this won't rug me?** (Non-custodial + on-chain verification answers this)
5. **Does it look professional?** (UX polish answers this)

**The UX redesign maps directly to these questions.** More mechanisms don't.

---

### What Differentiates Us

**Not features** — anyone can copy mechanisms (escrow, curves, staking are table stakes on other chains).

**What's hard to copy:**
- **BSV's instant finality** (other chains have pending blocks, BSV confirms in seconds)
- **No front-running** (no global mempool MEV, operator-sequenced is transparent + fair)
- **SPV proofs** (portable, verifiable, permanent — most chains don't offer this)
- **Real on-chain settlement** (not L2 IOUs, actual UTXO ownership)

**The UX redesign makes these visible.** That's the moat.

---

## VIII. Recommendation Summary

### Recommended Path: **UX-First, Narrow + Polished**

1. **Ship the 4-week UX roadmap** (Landing → Project Detail → Buy Modal → Portfolio)
2. **Keep STAS curve as default** (wallet-held tokens, operator-gated sell)
3. **Defer escrow presales** (validate demand first)
4. **Stay narrow** (best STAS launchpad, not feature kitchen sink)
5. **Target 4 weeks** (end of Sept, ready for user testing)

**After UX ships:**
- Get 10-20 real users (projects + buyers)
- Watch what they struggle with
- Ask what they wish existed
- **Then** decide next features (escrow? dashboards? staking?) based on real feedback, not speculation

---

## IX. Next Steps

**If you agree with the recommendation:**
1. Confirm priorities (Questions 1-5 above)
2. Start Week 1 (Landing + Project Detail enhancements)
3. Build in public (screenshot progress, demo early, iterate fast)

**If you disagree:**
1. Tell me which path you prefer (Path A UX vs Path B features)
2. Tell me which mechanisms matter most (escrow? ledger curves? dashboards?)
3. Tell me your launch timeline (4 weeks? 8 weeks? flexible?)

**I'll adapt the roadmap to your answers.**

---

**End of roadmap discussion.** What's your call?
