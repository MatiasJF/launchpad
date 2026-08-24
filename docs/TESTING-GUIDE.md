# Complete UX Testing Guide

**Fresh database seed complete** — 6 demo projects loaded, ready to test full user journey.

**Dev server**: http://localhost:3000

---

## Pre-requisites

1. **BSV Desktop Wallet** installed and set up with mainnet
2. **Some sats in your wallet** (for real on-chain purchases)
3. **Fresh database** (already reset via `pnpm prisma migrate reset --force`)

---

## Test Flow: End-to-End User Journey

### 1. Landing Page (`/`)

**What to test**:
- ✅ Stats strip shows: Live sales, Raised, Listings, Network (Mainnet)
- ✅ Project cards display in grid
- ✅ **Trending tab** — click it, verify sales re-sort by volume
- ✅ Live sales have **pulsing teal dot** on status pill
- ✅ Click "Explore sales" button → scrolls to #explore

**Expected state**: 6 seeded projects visible, some may be live/scheduled/completed

---

### 2. Project Detail Page (`/sale/[slug]`)

**What to test**:
- ✅ **Buy tab is default view** (not About or Stats)
- ✅ Price guarantee card visible (teal background)
  - Text: "Price locks when you confirm—no slippage, no front-running"
- ✅ **SPV explainer** — click "What is SPV?" to expand collapsible
  - Verify it explains: Instant finality, Portable proof, No global state
- ✅ BuyCard shows: Price per token, Sold progress bar, Status pill
- ✅ **About tab** — click it, verify project description + tokenomics visualization
- ✅ **Stats tab** — click it, verify full details grid

**Navigation**: Click any project card on landing page

---

### 3. Buy Modal Flow (5 Steps)

**What to test**:

#### Step 1: Connect Wallet
- ✅ Modal opens when clicking "Buy on mainnet"
- ✅ Step indicator shows 5 dots (first one is gold)
- ✅ Text: "Connect your BSV Desktop wallet to continue. Your keys never leave your wallet—this is non-custodial."
- ✅ Click "Connect Wallet"
- ✅ BSV Desktop prompts for connection approval
- ✅ After approval, modal advances to Step 2

#### Step 2: Amount Input
- ✅ Step indicator: second dot is gold, first is teal (completed)
- ✅ Amount input field pre-filled with 1000
- ✅ "max" button shows remaining tokens
- ✅ Click "max" → amount fills to remaining tokens
- ✅ Price preview shows: "Price per token" and "Total cost" (in sats)
- ✅ Enter invalid amount (0 or > remaining) → error message displays
- ✅ Click "Continue" with valid amount → advances to Step 3

#### Step 3: Confirm Purchase
- ✅ Step indicator: third dot is gold
- ✅ Summary card shows:
  - "You pay: X sats"
  - Down arrow icon
  - "You get: X TICKER"
  - Price, Network (BSV Mainnet), Finality (Instant)
- ✅ "Back" button returns to Step 2
- ✅ Click "Confirm Purchase" → advances to Step 4

#### Step 4: Processing
- ✅ Step indicator: fourth dot is gold
- ✅ Spinning gold icon displays
- ✅ Status text updates in real-time:
  1. "Reserving tokens..."
  2. "Creating payment transaction..."
  3. "Confirming payment..."
- ✅ BSV Desktop prompts for transaction signature
- ✅ After signing, payment broadcasts to mainnet
- ✅ Modal advances to Step 5 automatically

#### Step 5: Success
- ✅ Step indicator: fifth dot is gold
- ✅ Green checkmark icon displays
- ✅ Text: "Purchase Complete! Your order is placed and pending settlement."
- ✅ Summary shows: Tokens, Paid, Payment TX (link to WhatsOnChain)
- ✅ **"Download SPV Proof (.beef)" button** visible
  - Click it → `.beef` file downloads (check Downloads folder)
  - File name: `launchpad-TICKER-payment-TXID.beef`
- ✅ "Done" button closes modal
- ✅ **"View Portfolio →" link** visible

**Critical**: This creates a REAL on-chain transaction! Payment txid should be visible on WhatsOnChain within seconds.

---

### 4. Portfolio Page (`/portfolio`)

**What to test**:

#### Wallet Connection Gate
- ✅ Navigate to http://localhost:3000/portfolio
- ✅ If wallet not connected: "Connect your wallet" screen displays
- ✅ Click "Connect Wallet" → BSV Desktop prompts
- ✅ After connection, portfolio loads

#### Identity Display
- ✅ Header shows: "Identity: XXXX...XXXX" (truncated public key)

#### Holdings Tab (Default)
- ✅ **Empty state** (before any settled orders):
  - "No tokens yet" message
  - "Explore sales →" link
- ✅ **After purchase + settlement**:
  - Token card displays: logo, name, ticker, amount
  - "Latest delivery:" link to WhatsOnChain txid
  - "View project" button links to sale page
- ✅ Multiple purchases of same token → amounts sum correctly

#### History Tab
- ✅ Click "History" tab
- ✅ **Empty state** (before any orders):
  - "No orders yet" message
  - "Explore sales →" link
- ✅ **After purchase**:
  - Desktop (≥1024px): Table with 6 columns (Date, Token, Amount, Paid, Status, Proof)
  - Mobile (<1024px): Card layout with 2-column grid
  - Status pill shows order state (pending/settled/failed)
  - **Proof column**: "Pay ↗" link (payment tx) + "Delivery ↗" link (once settled)
  - Both links open WhatsOnChain in new tab

#### Skeleton Loaders
- ✅ While loading: Animated pulsing skeleton cards (not just "Loading..." text)

#### Responsive Design
- ✅ Resize browser to <1024px → history switches to card layout
- ✅ All text remains readable, no horizontal scroll

---

## Backend Testing (Admin Flow)

### 5. Admin Order Settlement

**Pre-requisite**: You need admin access (set your wallet's identity key in the Account table with `role = 'admin'`)

**What to test**:
1. Navigate to `/project/[slug]/manage` (replace [slug] with your project)
2. **Pending Orders** section shows orders awaiting settlement
3. Click "Settle Order" button
4. Operator backend:
   - Mints STAS tokens (if not minted yet)
   - Creates delivery transaction
   - Broadcasts to mainnet
5. Order state changes: `pending` → `settled`
6. Delivery txid appears in order record
7. **Portfolio refreshes**:
   - Holdings tab shows new tokens
   - History tab shows delivery link

**Critical**: Settlement is real on-chain! Delivery txid should be visible on WhatsOnChain.

---

## SPV Verification Testing

### 6. Verify BEEF Proof (Offline)

**What to test**:
1. Download `.beef` file from Buy Modal Success step
2. Use BSV SDK or external tool to parse BEEF:
   ```bash
   # Example using @bsv/sdk
   const beef = await readFile('launchpad-TICKER-payment-TXID.beef');
   const tx = Transaction.fromBEEF(beef);
   console.log(tx.id('hex')); // Should match TXID
   ```
3. Verify merkle path proves tx is in a block
4. No centralized API needed — proof is self-contained

**Expected**: BEEF contains payment transaction + merkle proof → verifiable independently.

---

### 7. WhatsOnChain Link Verification

**What to test**:
1. Click any "Pay ↗" or "Delivery ↗" link in Portfolio History
2. WhatsOnChain opens in new tab
3. Transaction details display:
   - Inputs, outputs, confirmations
   - Block height (once confirmed)
   - Merkle proof available via WoC API
4. Copy txid → paste into another block explorer (e.g., blockchair.com/bitcoin-sv) → same tx

**Expected**: All txids are real mainnet transactions, globally verifiable.

---

## Edge Cases & Error Handling

### 8. Buy Modal Error States

**What to test**:
- ✅ Enter 0 tokens → "Enter an amount greater than 0"
- ✅ Enter more than remaining → "Only X tokens remaining"
- ✅ Wallet connection fails → error message displays, step doesn't advance
- ✅ User rejects transaction signature → stays on Processing step, error displays
- ✅ Close modal mid-flow → state resets on reopen (doesn't remember previous step)

### 9. Portfolio Error States

**What to test**:
- ✅ Disconnect wallet → portfolio shows "Connect your wallet" gate
- ✅ No orders yet → Holdings and History show empty states with "Explore sales →" link
- ✅ Network error during fetch → error message displays (not infinite loading)

### 10. Responsive Breakpoints

**What to test**:
- ✅ Desktop (1920px): Full layouts, tables display
- ✅ Laptop (1440px): Same as desktop
- ✅ Tablet (1024px): History table → cards
- ✅ Mobile (768px): Single column layouts
- ✅ Small mobile (375px): All content visible, no horizontal scroll

---

## Performance Testing

### 11. Bundle Size

**What to test**:
1. Build production: `pnpm --filter @launchpad/web build`
2. Check output:
   ```
   /                  ~110 KB First Load JS
   /portfolio         ~124 KB First Load JS
   /sale/[slug]       ~129 KB First Load JS
   ```
3. Verify all routes under 130 KB (Next.js warning threshold)

### 12. Loading States

**What to test**:
- ✅ Skeleton loaders appear immediately (not after 500ms delay)
- ✅ No "flash of empty content" (skeleton → data transition is smooth)
- ✅ Buy Modal Processing step shows spinner + status updates in real-time

---

## Cross-Browser Testing

### 13. Browser Compatibility

**What to test**:
- ✅ Chrome/Edge (Chromium): All features work
- ✅ Firefox: All features work
- ✅ Safari: All features work
- ✅ Mobile Safari (iOS): Responsive layouts, modals work
- ✅ Mobile Chrome (Android): Same as mobile Safari

**Known limitation**: BSV Desktop wallet is desktop-only (no mobile wallet integration yet).

---

## Accessibility Testing

### 14. Keyboard Navigation

**What to test**:
- ✅ Tab through landing page → all interactive elements focusable
- ✅ Tab through Buy Modal → step order is logical
- ✅ Press Escape in modal → modal closes
- ✅ Portfolio table is keyboard-navigable

### 15. Screen Reader Support

**What to test**:
- ✅ All images have `alt` attributes
- ✅ Buttons have descriptive labels (not just icons)
- ✅ Status pills announce state changes

---

## Security Testing

### 16. Wallet Safety

**What to test**:
- ✅ Private keys NEVER leave BSV Desktop wallet
- ✅ Frontend only receives signed transactions (not keys)
- ✅ No API endpoints expose wallet secrets
- ✅ All on-chain transactions are non-custodial

### 17. SQL Injection Protection

**What to test**:
- ✅ Portfolio queries use Prisma (parameterized queries, no raw SQL)
- ✅ User input in Buy Modal is sanitized (amount is parsed as BigInt)

---

## Known Issues & Future Work

### Current Limitations

1. **Manual settlement**: Admin must click "Settle Order" button (not automated)
2. **No escrow presales**: Instant swaps only (escrow deferred per roadmap decision)
3. **No bonding curves UI**: Backend ready (ADR-028), frontend not built yet
4. **Desktop wallet only**: No mobile wallet integration

### Next Steps (Post-Launch)

1. Automated settlement queue (operator daemon)
2. Escrow presale flow (if demand exists)
3. Bonding curve UI (buy/sell buttons + price chart)
4. Mobile wallet integration (if BSV Desktop releases mobile version)

---

## Quick Reset (For Re-Testing)

To wipe database and start fresh:

```bash
cd packages/db
pnpm prisma migrate reset --force
```

This:
1. Drops all tables
2. Re-runs migrations
3. Seeds 6 demo projects

---

## Summary: What "Complete Testing" Means

✅ **All 4 weeks of UX work tested**:
1. Landing page (Trending tab, live indicators)
2. Project detail (Buy tab, SPV explainer)
3. Buy Modal (5-step flow, BEEF download)
4. Portfolio (Holdings/History tabs, WoC links, responsive)

✅ **Real mainnet transactions**:
- Payment tx broadcasts on-chain
- Settlement tx delivers tokens on-chain
- All txids verifiable on WhatsOnChain

✅ **SPV verification**:
- BEEF downloads work
- Merkle proofs accessible
- No centralized API required for verification

✅ **Responsive design**:
- Desktop, tablet, mobile layouts tested
- No horizontal scroll on small screens

✅ **Error handling**:
- Invalid inputs show clear error messages
- Wallet connection failures don't break UI
- Empty states guide users to next action

---

**You're now ready to test the complete user journey from landing → buy → portfolio → SPV verification!** 🚀

Start at: http://localhost:3000
