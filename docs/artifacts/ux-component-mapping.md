# UX Component Mapping — Mockup to Codebase

**Context**: This document maps the 5 UX mockups created on 2026-08-24 to the existing BSV Launchpad codebase. It identifies what exists, what's missing, and where to build.

**Related**: `docs/artifacts/ux-mockups-detailed.md` (the mockups themselves)

---

## 1. Landing/Discovery Page

**Target**: `/` (home route)
**Existing file**: `apps/web/app/page.tsx`

### What exists
- ✅ **ProjectCard component**: `apps/web/components/project-card.tsx`
  - Shows: thumbnail, title, description, raised/goal, progress bar, "Learn More" button
  - Location: Renders from `const projects = await db.project.findMany(...)` at page.tsx:10
  - Data source: Prisma `Project` model with `createdBy: { include: { profile: true } }`

### What's missing
- ❌ **Tabs navigation** (Live, Trending, Completed)
  - Need: `<Tabs>` component at page level with client-side filtering
  - Data: Already available via `project.status` (DRAFT/ACTIVE/COMPLETED)
  - Build: Add `"use client"` wrapper or Server Component with search params `?tab=live`

- ❌ **"Trending" sort algorithm**
  - Need: Define trending metric (volume last 24h? unique buyers? price velocity?)
  - Data: Would need trade aggregation query on `Trade` model
  - Build: Add `getTrendingProjects()` function in `apps/web/lib/db-queries.ts` (or new file)

- ❌ **Live status indicators**
  - Need: "🟢 Live" pill on active launches
  - Data: `project.status === 'ACTIVE'`
  - Build: Add conditional badge in ProjectCard component

- ❌ **Stats strip** (Total Raised, Active Launches, Total Projects)
  - Need: Aggregate query across all projects
  - Data: Sum of all trades' `bsvSpent`, count where status ACTIVE, total count
  - Build: Add `getGlobalStats()` function, render above tabs

### Build location
- **File**: `apps/web/app/page.tsx` (enhance existing)
- **New components**:
  - `apps/web/components/discovery-tabs.tsx` (client component)
  - `apps/web/components/stats-strip.tsx` (server component)
- **New queries**: `apps/web/lib/stats-queries.ts`

---

## 2. Project Detail Page

**Target**: `/project/[slug]`
**Existing file**: `apps/web/app/project/[slug]/page.tsx`

### What exists
- ✅ **ProjectDetail component**: `apps/web/components/project-detail.tsx`
  - Shows: header, thumbnail, description, goal, raised, progress
  - Location: Imported at page.tsx:14
  - Data source: `await db.project.findUnique({ where: { slug }, include: { createdBy: { include: { profile: true } } } })`

- ✅ **Buy action**: `buyProjectTokens` Server Action
  - File: `apps/web/lib/stas-actions.ts:567`
  - Flow: Creates STAS vault → pending trade → wallet.createAction → broadcast → deliver
  - Already wired to ProjectDetail component

### What's missing
- ❌ **Tabs (Buy, About, Stats)** with persistent state
  - Need: Client-side tab switcher (default Buy)
  - Build: Convert ProjectDetail to client component or extract tab content to client wrapper

- ❌ **"Price guarantee" messaging** in Buy tab
  - Need: Explicit callout "Price locks when you confirm—no slippage, no front-running"
  - Data: None (static text)
  - Build: Add info card/alert in Buy tab content

- ❌ **About tab** content
  - Need: Rich-text project description, team info, links
  - Data: Already have `project.description` (string). May need `project.longDescription` (text field) in schema
  - Build: Add Markdown renderer or rich-text field to Prisma schema

- ❌ **Stats tab** content
  - Need: Total buyers, avg buy size, distribution chart, recent trades
  - Data: Aggregate queries on `Trade` model filtered by `projectId`
  - Build: New `getProjectStats(projectId)` query, add chart component (recharts)

- ❌ **Recent activity feed** (bottom of page)
  - Need: "User X bought Y tokens Z mins ago"
  - Data: `Trade` model with `buyer` relation, ordered by `createdAt DESC`
  - Build: Server Component fetching latest 10 trades, render as list

### Build location
- **File**: `apps/web/app/project/[slug]/page.tsx` (enhance)
- **New components**:
  - `apps/web/components/project-tabs.tsx` (client wrapper)
  - `apps/web/components/project-stats.tsx` (Stats tab content)
  - `apps/web/components/recent-trades.tsx` (activity feed)
- **Schema change**: Add `longDescription: String? @db.Text` to Project model
- **New queries**: `apps/web/lib/project-stats.ts`

---

## 3. Buy Flow (Modal)

**Target**: Modal sequence triggered from Project Detail page
**Existing**: Partial — wallet connection exists, but no explicit modal UI

### What exists
- ✅ **Wallet connection**: `connectWallet()` action
  - File: `apps/web/lib/wallet-actions.ts:21`
  - Flow: Auto-detects BSV Desktop via BRC-100 HTTP substrate → stores session
  - Returns: `{ wallet, identityKey }` on success

- ✅ **Buy transaction creation**: `buyProjectTokens` Server Action
  - File: `apps/web/lib/stas-actions.ts:567`
  - Flow: Validates → creates vault → createAction (unsigned) → returns `{ ok, action, deliveryTxid? }`

- ✅ **Action signing**: Client-side `.signAction(action)` call
  - File: Inline in ProjectDetail component (assumed — not extracted to lib yet)
  - Uses: `wallet.signAction(action)` → broadcasts signed tx

### What's missing
- ❌ **Modal UI component** with steps
  - Need: Multi-step modal (Wallet Connect → Amount Input → Confirm → Processing → Success)
  - Build: Create `apps/web/components/buy-modal.tsx` (client component with state machine)

- ❌ **Amount input step**
  - Need: Token quantity input, real-time BSV cost calculation, max affordable hint
  - Data: Pull from `project.pricePerToken`, user's wallet balance (via wallet.getBalance())
  - Build: Form with live cost preview, validation (min 1, max based on available supply)

- ❌ **Confirmation step** with breakdown
  - Need: Show "You pay X BSV → You get Y tokens", "Price: Z BSV/token", "Finality: Instant"
  - Data: From previous step + project data
  - Build: Static summary card with "Confirm Purchase" CTA

- ❌ **Processing step** with SPV proof download
  - Need: Spinner + "Broadcasting... Delivering... Verifying..." status, then auto-download BEEF
  - Data: From `buyProjectTokens` return value (`{ deliveryTxid, deliveryBeef }`)
  - Build: Poll delivery status (or use Server Action returned data), trigger `downloadBeef()`

- ❌ **SPV proof download** function
  - Need: Convert `deliveryBeef: number[]` to downloadable `.beef` file
  - Build: Add `apps/web/lib/download-beef.ts` utility (Blob + download trigger)

### Build location
- **File**: `apps/web/components/buy-modal.tsx` (new, client component)
- **Utilities**: `apps/web/lib/download-beef.ts` (BEEF → file download)
- **Integration**: Import BuyModal into ProjectDetail, trigger on "Buy Now" button

---

## 4. Post-Purchase Success Screen

**Target**: Modal final step OR `/receipt/[tradeId]` dedicated page
**Existing**: None (currently no post-purchase UI)

### What exists
- ✅ **Trade record**: Created in `buyProjectTokens`
  - Model: `Trade` with `id, projectId, buyerId, tokenAmount, bsvSpent, deliveryTxid, createdAt`
  - Location: `apps/web/lib/stas-actions.ts:629` (after delivery broadcast)

- ✅ **Delivery BEEF**: Already generated
  - Field: `deliveryBeef: number[]` returned from `deliverStasToBuyer`
  - Location: `apps/web/lib/stas-actions.ts:474` returns `{ ok: true, deliveryBeef, ... }`

### What's missing
- ❌ **Receipt page** OR **Success modal step**
  - Need: Shows trade summary, "Tokens delivered to your wallet", SPV proof download
  - Data: Trade record (fetch by `tradeId` or pass from modal state)
  - Build: Either final modal step (simpler) OR new route `apps/web/app/receipt/[id]/page.tsx`

- ❌ **SPV proof download button**
  - Need: "Download BEEF" button → triggers browser download of `.beef` file
  - Data: `deliveryBeef` from Trade or modal state
  - Build: `downloadBeef(deliveryBeef, `launchpad-delivery-${tradeId}.beef`)` utility

- ❌ **"What is SPV?" explainer**
  - Need: Collapsible or modal explaining instant finality + proof portability
  - Data: Static educational content
  - Build: Add `apps/web/components/spv-explainer.tsx` (collapsible card)

- ❌ **Next actions** (View Portfolio, Share, Back to Project)
  - Need: CTA buttons
  - Build: Link buttons in success screen

### Build location
- **Option A** (simpler): Final step in `buy-modal.tsx` (recommended for MVP)
- **Option B**: New route `apps/web/app/receipt/[id]/page.tsx`
- **Utilities**: `apps/web/lib/download-beef.ts` (shared with Buy Flow)
- **Component**: `apps/web/components/spv-explainer.tsx`

---

## 5. Portfolio / Trade History

**Target**: `/portfolio` (new route)
**Existing**: None (no portfolio page exists)

### What exists
- ✅ **Trade data**: All purchases recorded in `Trade` model
  - Fields: `id, projectId, buyerId, tokenAmount, bsvSpent, deliveryTxid, createdAt`
  - Relations: `project: Project`, `buyer: User`
  - Location: Query via `db.trade.findMany({ where: { buyerId }, include: { project: true }, orderBy: { createdAt: 'desc' } })`

- ✅ **User session**: `getUserSession()` from wallet-actions
  - File: `apps/web/lib/wallet-actions.ts:38`
  - Returns: `{ userId }` (pkh-derived session)

### What's missing
- ❌ **Portfolio page** route
  - Need: `/portfolio` Server Component
  - Build: Create `apps/web/app/portfolio/page.tsx`

- ❌ **Holdings tab** (current tokens held)
  - Need: Group trades by project, show total tokens per project, current value estimate
  - Data: Aggregate `Trade.tokenAmount` by `projectId`, join with current `project.pricePerToken`
  - Build: Query `getPortfolioHoldings(userId)`, render as card grid

- ❌ **Activity tab** (trade history)
  - Need: Chronological list of all buys (date, project, amount, cost, delivery txid link)
  - Data: `Trade` records ordered by `createdAt DESC`
  - Build: Query `getUserTrades(userId)`, render as table/list

- ❌ **Stats tab** (aggregate analytics)
  - Need: Total spent (BSV), total tokens held, number of projects, avg buy size
  - Data: Aggregate queries on `Trade` model
  - Build: Query `getPortfolioStats(userId)`, render as stat cards

- ❌ **Transaction explorer links**
  - Need: Each trade shows link to WhatsOnChain for `deliveryTxid`
  - Data: `deliveryTxid` from Trade
  - Build: Helper `wocLink(txid, chain)` → `https://whatsonchain.com/tx/${txid}`

### Build location
- **File**: `apps/web/app/portfolio/page.tsx` (new route)
- **Components**:
  - `apps/web/components/portfolio-tabs.tsx` (client wrapper)
  - `apps/web/components/holdings-grid.tsx` (Holdings tab)
  - `apps/web/components/activity-list.tsx` (Activity tab)
  - `apps/web/components/portfolio-stats.tsx` (Stats tab)
- **Queries**: `apps/web/lib/portfolio-queries.ts`
- **Utilities**: `apps/web/lib/woc-link.ts` (txid → explorer URL)

---

## Summary: Build Order

For MVP implementation, recommend this sequence:

1. **Landing enhancements** (high-impact, low-effort)
   - Add Live/Completed tabs (filter existing `ProjectCard` grid)
   - Add stats strip (total raised, active launches)
   - Add live status pills to cards

2. **Project Detail tabs** (medium effort)
   - Extract Buy content into tab
   - Add About tab (render existing `description`, add `longDescription` field later)
   - Add Stats tab (query + chart component)

3. **Buy Modal** (high-effort, core UX)
   - Build full step sequence (Connect → Amount → Confirm → Processing → Success)
   - Integrate SPV proof download
   - Add price guarantee messaging

4. **Portfolio page** (medium effort)
   - Build `/portfolio` route
   - Add Holdings + Activity tabs (Stats tab can wait)
   - Link from nav + post-purchase success

5. **Post-purchase receipt** (low effort — piggyback on Buy Modal)
   - Use final modal step (no separate route needed for MVP)
   - Ensure BEEF download + explainer present

---

## Files to Create

### New routes
- `apps/web/app/portfolio/page.tsx`

### New components
- `apps/web/components/discovery-tabs.tsx` (client)
- `apps/web/components/stats-strip.tsx` (server)
- `apps/web/components/project-tabs.tsx` (client)
- `apps/web/components/project-stats.tsx` (server)
- `apps/web/components/recent-trades.tsx` (server)
- `apps/web/components/buy-modal.tsx` (client)
- `apps/web/components/spv-explainer.tsx` (client)
- `apps/web/components/portfolio-tabs.tsx` (client)
- `apps/web/components/holdings-grid.tsx` (server)
- `apps/web/components/activity-list.tsx` (server)
- `apps/web/components/portfolio-stats.tsx` (server)

### New utilities
- `apps/web/lib/stats-queries.ts` (global stats)
- `apps/web/lib/project-stats.ts` (per-project aggregates)
- `apps/web/lib/portfolio-queries.ts` (user holdings + activity)
- `apps/web/lib/download-beef.ts` (BEEF → file download)
- `apps/web/lib/woc-link.ts` (txid → WhatsOnChain URL)

### Schema changes
- Add `longDescription: String? @db.Text` to `Project` model (optional, for About tab rich content)

---

**End of mapping.** Next step: user decides whether to implement these UX flows or pivot to roadmap discussion.
