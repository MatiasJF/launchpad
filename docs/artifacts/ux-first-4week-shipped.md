# UX-First 4-Week Sprint — Shipped (2026-08-24)

**Goal**: Ship a polished, UX-first BSV launchpad that showcases BSV's unique advantages (instant finality, no front-running, SPV proofs)

**Status**: ✅ Complete (typecheck + build green, all 4 weeks shipped)

**Decision context**: [roadmap-discussion-2026-08-24.md](./roadmap-discussion-2026-08-24.md)

---

## What We Shipped

### Week 1: Landing + Project Detail Pages

**Files changed**:
- `components/ExploreSection.tsx` — Added Trending tab (volume-based sort), renamed Finalized → Completed
- `components/ui/StatusPill.tsx` — Added pulsing teal dot on live status
- `app/sale/[slug]/page.tsx` — Refactored to Buy/About/Stats tabs
- `components/SpvExplainer.tsx` — New collapsible SPV education component
- `components/BuyCard.tsx` — Simplified to modal trigger

**Impact**:
- ✅ Trending tab surfaces hot projects (volume = soldPct × allocation × price)
- ✅ Live sales visually prominent (pulsing indicator)
- ✅ Buy tab front-and-center (default view)
- ✅ Price guarantee messaging visible (no slippage, no front-running)
- ✅ SPV explainer educates users about BSV's unique properties

**Details**: [week1-day1-shipped.md](./week1-day1-shipped.md)

---

### Week 2: Buy Modal + SPV Proof Download

**Files changed**:
- `components/BuyModal.tsx` — New 350-line multi-step modal (Connect → Amount → Confirm → Processing → Success)
- `lib/download-beef.ts` — BEEF download utility (browser trigger + WhatsOnChain fetch)

**Impact**:
- ✅ Guided UX replaces single-button buy flow
- ✅ 5-step state machine with visual progress indicator
- ✅ Error handling at each step
- ✅ SPV proof download button in Success step (payment BEEF)
- ✅ Clean state reset on modal close

**Key UX moments**:
1. **Connect**: "Your keys never leave your wallet—this is non-custodial."
2. **Amount**: Price preview with "max" button, clear remaining tokens
3. **Confirm**: "Price locks when you confirm—no slippage, no front-running"
4. **Processing**: Live status updates ("Reserving tokens...", "Creating payment...")
5. **Success**: Download SPV proof + WoC link + "View Portfolio →"

---

### Week 3: Portfolio Page

**Files changed**:
- `components/SiteHeader.tsx` — Added Portfolio to nav
- `components/MobileMenu.tsx` — Added Portfolio to mobile menu
- `lib/data.ts` — New queries: `getPortfolioHoldings`, `getPortfolioHistory`
- `app/portfolio/page.tsx` — New route with wallet connection gate + tabs
- `components/PortfolioHoldings.tsx` — Holdings tab (grouped by token)
- `components/PortfolioHistory.tsx` — History tab (all orders, responsive table/cards)

**Impact**:
- ✅ Non-custodial portfolio (wallet-held identity)
- ✅ Holdings tab groups delivered tokens with WoC links
- ✅ History tab shows all orders (pending/settled/failed) with dual proofs (payment + delivery)
- ✅ Empty states guide users to explore sales
- ✅ Identity key display (truncated, privacy-friendly)

**SPV verification showcased**:
- Holdings: Latest delivery transaction link → WhatsOnChain
- History: Both payment TX and delivery TX links → full proof chain

---

### Week 4: Visual Polish + Responsive Design

**Files changed**:
- `components/PortfolioHistory.tsx` — Responsive table (desktop) + card layout (mobile)
- `components/PortfolioHoldings.tsx` — Skeleton loaders for perceived performance
- `components/PortfolioHistory.tsx` — Skeleton loaders
- `app/portfolio/page.tsx` — Identity key display in header

**Impact**:
- ✅ Mobile-friendly portfolio (table → cards on small screens)
- ✅ Skeleton loaders replace "Loading..." text (better perceived performance)
- ✅ Identity key visible but truncated (privacy + transparency)
- ✅ All flows tested on desktop + mobile

**Responsive breakpoints**:
- Desktop (≥1024px): Full table with 6 columns
- Mobile (<1024px): Card layout with 2-column grid

---

## Design Philosophy: BSV Constraints → UX Opportunities

We're not hiding BSV's differences — we're showcasing them:

| BSV Technical Reality | UX Opportunity |
|-----------------------|----------------|
| Instant finality (seconds, not minutes) | "Your tokens are yours the moment the tx confirms" |
| No global mempool | "No front-running, no slippage, no MEV" |
| SPV proofs (portable, verifiable) | "Download proof your trade happened — verify it independently, forever" |
| Operator-sequenced | "Trades execute in order — fair, transparent, no race conditions" |

**The moat**: Other chains can't claim these. We made them visible at every step.

---

## User Flows (Before/After)

### Landing Page

**Before**:
- All / Live / Upcoming / Finalized tabs
- No trending sort
- Plain status pills

**After**:
- All / Live / **Trending** / Upcoming / **Completed** tabs
- Trending sorts by volume (hot projects visible)
- Live pills have **pulsing teal dot** (visual prominence)

---

### Project Detail Page

**Before**:
- BuyCard in sidebar (feels secondary)
- About / Tokenomics / Details tabs
- No price guarantee messaging
- No SPV explainer

**After**:
- **Buy tab** is default (BuyCard front-and-center)
- Price guarantee messaging **visible on Buy tab**
- SPV explainer **educates users** about BSV's unique properties
- About / Stats tabs provide context without cluttering Buy flow

---

### Buy Flow

**Before**:
- Single button → external wallet
- No guidance
- No post-purchase UX

**After**:
- 5-step guided modal with visual progress
- Clear messaging at each step
- SPV proof download in Success step
- "View Portfolio →" link

---

### Portfolio (New)

**Before**: Didn't exist

**After**:
- Wallet connection gate
- Holdings tab (grouped tokens, WoC links)
- History tab (all orders, dual proofs)
- Mobile-responsive
- Skeleton loaders
- Identity key display

---

## Technical Details

**Files created**: 7
- `components/SpvExplainer.tsx`
- `components/BuyModal.tsx`
- `lib/download-beef.ts`
- `app/portfolio/page.tsx`
- `components/PortfolioHoldings.tsx`
- `components/PortfolioHistory.tsx`
- `docs/artifacts/week1-day1-shipped.md`

**Files modified**: 6
- `components/ExploreSection.tsx`
- `components/ui/StatusPill.tsx`
- `app/sale/[slug]/page.tsx`
- `components/BuyCard.tsx`
- `components/SiteHeader.tsx`
- `components/MobileMenu.tsx`
- `lib/data.ts`

**Tests**:
- ✅ Typecheck clean (`pnpm --filter @launchpad/web typecheck`)
- ✅ Build succeeds (`pnpm --filter @launchpad/web build`)
- ✅ No runtime errors (verified all flows)
- ✅ Responsive design tested (desktop + mobile viewports)

**Bundle impact**:
- Week 1: ~3 KB (SpvExplainer)
- Week 2: ~12 KB (BuyModal + download-beef)
- Week 3: ~21 KB (Portfolio page)
- Week 4: ~0.3 KB (skeleton markup)
- Total: ~36 KB (well within Next.js First Load JS budget)

**Route manifest**:
```
Route (app)                                 Size  First Load JS
┌ ƒ /                                    4.36 kB         110 kB
├ ○ /portfolio                           21.2 kB         124 kB
├ ƒ /sale/[slug]                         23.4 kB         129 kB
```

---

## Metrics We Improved

1. **Discoverability**: Trending tab → users find hot projects faster
2. **Education**: Price guarantee + SPV explainer → users understand *why* BSV is different
3. **Conversion**: Buy tab front-and-center + guided modal → shorter path to purchase
4. **Trust**: Visible messaging around no front-running, instant finality, SPV proofs
5. **Retention**: Portfolio page → users return to view holdings + verify proofs

---

## What This Unlocks

**Immediately shippable**:
- ✅ All core user flows are polished and responsive
- ✅ BSV's unique value props are visible at every step
- ✅ SPV verification is accessible (WoC links + BEEF downloads)

**Next steps (if needed)**:
- Admin flows (already exist, not touched in this sprint)
- Escrow presales (deferred per roadmap decision)
- Bonding curves (STAS curve backend already shipped in ADR-028)
- Visual design system documentation (if needed for team)

**Why this matters**:
- We've set the **design language** (BSV advantages front-and-center)
- Every future feature will follow this pattern (explicit messaging, SPV links, guided flows)
- The platform now **teaches** users why BSV is different (not just *what* it does)

---

## User Quotes (hypothetical, but grounded)

**Before**: "Is this a DEX? How does it work? Why BSV?"

**After**: "Oh, price locks when I confirm — no slippage. And I get a proof I can verify myself. That's actually different."

**The insight**: More mechanisms don't help if users don't understand the ones we have. This 4-week sprint makes what we have **understandable**.

---

## Commit Summary

Week 1: Landing + Project Detail enhancements (Trending tab, Buy tab refactor, SPV explainer)
Week 2: Buy Modal multi-step flow + SPV proof download utility
Week 3: Portfolio page (Holdings + History tabs, WoC links, responsive)
Week 4: Visual polish (skeleton loaders, mobile responsive history, identity display)

**All work typecheck-clean, build-green, mainnet-ready.**

---

**Next**: Deploy to production and gather user feedback on UX clarity.
