# Complete Test Checklist — UX-First 4-Week Sprint

**URL**: http://localhost:3000

**Instructions**: For each test, mark ✅ (pass) or ❌ (fail). If fail, note the error/issue.

---

## PRE-TEST SETUP

- [ ] BSV Desktop Wallet installed and connected to mainnet
- [ ] Fresh database reset complete (`pnpm prisma migrate reset --force`)
- [ ] Dev server running at http://localhost:3000
- [ ] Some sats in wallet for real purchase testing

---

## TEST 1: LANDING PAGE (`/`)

### 1.1 Initial Load
- [ yes ] Page loads without errors
- [ yes ] Logo "BSV Launchpad" visible in header
- [ yes ] Navigation shows: Explore, Portfolio, Submit, Docs
- [ yes ] Wallet button visible in top-right (shows "Connect Wallet")
- Comment: the background gradients and lights are not fully wide, in wide screen it cuts on the right

### 1.2 Hero Section
- [ yes ] Heading: "Launch and back tokens, settled on-chain."
- [ yes ] "settled on-chain" is gradient gold text
- [ yes ] Subheading mentions STAS tokens and SPV-verifiable
- [ yes ] "Explore sales" button (primary, gold)
- [ yes ] "How settlement works" button (secondary)
- [ yes ] Feature pills visible: Non-custodial, SPV-verifiable, Mainnet only, 1 sat = 1 token
- Comment: none

### 1.3 Stats Strip
- [ yes ] "Live sales" stat shows number
- [ yes ] "Raised (sats)" stat shows formatted number
- [ yes ] "Listings" stat shows total count
- [ yes ] "Network" stat shows "Mainnet"
- Comment: none

### 1.4 Explore Section
- [ yes ] Filter tabs visible: All, Live, Trending, Upcoming, Completed
- [ yes ] "All" tab is active (highlighted) by default
- [ yes ] Project cards display in grid (responsive columns)
- [ yes ] At least 6 project cards visible (from seed)
- Comment: none

### 1.5 Project Cards
**For each visible card:**
- [ yes ] Project logo/icon displays (or placeholder)
- [ yes ] Project name visible
- [ yes ] Ticker visible (e.g., "BT5")
- [ yes ] Status pill visible (e.g., "live", "scheduled")
- [ no ] **Live cards have pulsing teal dot** on status pill
- [ yes ] Price shows "X sats" per token
- [ yes ] Progress bar shows sold percentage
- [ yes] Hovering card shows subtle highlight
- Comment: Status pills should be of different colours and there is no pulse on the teal dot

### 1.6 Filter Tabs
**Test each tab:**

#### Click "Live" tab:
- [ yes ] Tab becomes active (highlighted)
- [ yes ] Only live sales display
- [ yes ] Cards with pulsing dots remain visible
- [ yes ] Other status cards are hidden
- Comment: none

#### Click "Trending" tab:
- [ yes ] Tab becomes active
- [ yes ] Only live sales display
- [ yes ] **Cards re-sort by volume** (highest volume first)
- [ yes ] Volume = soldPct × publicAllocation × priceSats
- [ yes ] Order changes from "All" tab order
- Comment: none

#### Click "Upcoming" tab:
- [ yes ] Tab becomes active
- [ yes ] Only scheduled/upcoming sales display
- [ yes ] No live or completed sales visible
- Comment: none

#### Click "Completed" tab:
- [ yes ] Tab becomes active
- [ yes ] Only finalized sales display (status says "Completed", not "Finalized")
- [ yes ] No live or upcoming sales visible
- Comment: none

#### Click "All" tab again:
- [ yes ] All sales display again
- [  yes] Original order restored
- Comment: none

### 1.7 Mobile Navigation
**Resize browser to <640px:**
- [ yes ] Hamburger menu icon appears (replaces desktop nav)
- [ yes ] Desktop nav links hidden
- [ yes ] Wallet button still visible
- [ yes ] Click hamburger → mobile menu opens
- [ yes ] Mobile menu shows: Explore, Portfolio, Submit, Docs
- [ yes ] Click menu link → menu closes
- [ yes ] Click outside menu → menu closes
- Comment: none

### 1.8 Footer
- [ yes ] Footer visible at bottom
- [ yes ] Contains project info or links
- Comment: none

**Issue notes**:
```
[Write any issues here]
```

---

## TEST 2: PROJECT DETAIL PAGE (`/sale/[slug]`)

**Action**: Click any project card from landing page

### 2.1 Initial Load
- [ yes ] Page loads without errors
- [ yes ] URL changes to `/sale/[slug]` (e.g., `/sale/meridian`)
- [ yes ] Header/footer still visible
- [ yes ] Project name in hero section
- [ yes ] Project logo/banner displays

### 2.2 Tab Structure
- [ yes ] Three tabs visible: Buy, About, Stats
- [ yes ] **Buy tab is active by default** (not About)
- [ yes ] Tab indicator shows active state (gold underline or highlight)

### 2.3 Buy Tab Content (Default View)

#### Price Guarantee Card:
- [ yes ] Teal/green background card visible
- [ yes ] Heading: "🛡️ Price Guarantee"
- [ yes ] Text mentions: "Price locks when you confirm—no slippage, no front-running"
- [ yes ] Text mentions BSV has no global mempool
- Comment: If page to narrow on desktop the texts start overlapping

#### Token Details Grid:
- [ yes ] "Total Supply" row with value
- [ yes ] "Public Allocation" row with value
- [ yes ] "Price" row shows sats per token
- [ yes ] "Remaining" row shows tokens left
- [ yes ] "Sold" row shows percentage
- [ yes ] "Network" row shows "BSV Mainnet"
- [ yes ] "Settlement" row shows "SPV-verifiable"
- [ yes ] "Type" row shows sale type (e.g., "instant")

#### SPV Explainer:
- [ yes ] "What is SPV?" accordion/collapsible visible
- [ yes ] **Collapsed by default** (content hidden)
- [ yes ] Click "What is SPV?" → accordion expands
- [ yes ] Expanded content shows:
  - [ yes ] "SPV (Simplified Payment Verification)" heading
  - [ yes ] "Instant finality" explanation
  - [ yes ] "Portable proof" explanation
  - [ yes ] "No global state" explanation
- [ yes ] Click again → accordion collapses

#### BuyCard (Right Column):
- [ yes ] Card visible in right column (desktop) or below details (mobile)
- [ yes ] "Price per token" shows sats
- [ yes ] Status pill visible (matches project status)
- [ yes ] If not "scheduled": Progress bar shows sold percentage
- [ yes ]  If "scheduled": Countdown timer visible ("Starts in X d Y h Z m")
- [ yes ] If "live": "Ends in" countdown (if endsAt set)
- [ yes ] Button state:
  - [ yes ] If sale open: "Buy on mainnet" (primary, clickable)
  - [ yes ] If upcoming: "Not open yet" (disabled)
  - [ yes ] If ended: "Sale ended" (disabled)
- [ yes ] "settlement is SPV-verifiable" text with shield icon
- Comment: status pills should follow same comment as in the explore grid

### 2.4 About Tab
**Click "About" tab:**
- [ yes ] Tab becomes active
- [ yes ] Buy tab content hidden
- [ yes ] Project description visible (markdown formatted)
- [ yes ] Tokenomics section visible (if available)
- [ yes ] Allocation visualization (pie chart or bars, if implemented)

### 2.5 Stats Tab
**Click "Stats" tab:**
- [ yes ] Tab becomes active
- [ yes ] Full details grid visible (similar to Buy tab grid but more comprehensive)
- [ yes ] All token stats displayed

### 2.6 Responsive Layout
**Resize to <1024px:**
- [ yes ] BuyCard moves below details (stacks vertically)
- [ yes ] Tabs still visible and functional
- [ no ] All content remains readable
- Comment: on resizing there aare scrollbars that appear on the tabs and they are default not matching the style

**Issue notes**:
```
[Write any issues here]
```

---

## TEST 3: BUY MODAL FLOW (5 Steps)

**Pre-requisite**: On project detail page with "Buy on mainnet" button enabled (live sale)

### 3.1 Modal Opening
**Click "Buy on mainnet" button:**
- [ yes ] Modal opens (overlay darkens background)
- [ yes ] Modal centered on screen
- [ yes ] Close button (X) visible in top-right
- [ yes ] Click outside modal → modal does NOT close (prevents accidental close)
- [ yes ] Click X button → modal closes
- Comment: wallet already connected but still asks for connection, the overlay darkens only some section not the entire page which it should.

**Re-open modal for step testing:**

### 3.2 Step Indicator
- [ yes ] 5 dots visible at top of modal
- [ yes ] Dots separated by horizontal lines
- [ yes ] First dot is gold (active)
- [ yes ] Other 4 dots are gray (pending)

### 3.3 STEP 1: Connect Wallet

#### Content:
- [ yes ] Heading: "Connect Wallet"
- [ yes ] Subtext: "Connect your BSV Desktop wallet to continue. Your keys never leave your wallet—this is non-custodial."
- [ ]yes  "Connect Wallet" button (primary, gold)

#### Wallet Connection (if wallet NOT connected):
**Click "Connect Wallet":**
- [ no ] BSV Desktop wallet prompts for connection approval
- [ no ] Wallet shows app name, requested permissions
- [ no ] Click "Allow" in wallet → connection succeeds
- [ yes ] Modal advances to Step 2 automatically
- [ yes ] No error message displays
- Comment: no conection aproval, it just connects

#### Wallet Connection Error (optional test):
**Click "Deny" in wallet:**
- [ no ] Error message displays in modal (red text or red box)
- [ no ] Modal stays on Step 1
- [ no ] User can retry by clicking "Connect Wallet" again
- Comment: no connection aproval, it just connects

#### If Wallet Already Connected:
- [ no ] Modal skips Step 1 → starts at Step 2 (Amount)
- Comment: it asks to connect even when alrady connected outside

### 3.4 STEP 2: Amount Input

#### Step Indicator:
- [ yes ] Second dot is now gold (active)
- [ yes ] First dot is teal (completed)
- [ yes ] Remaining 3 dots are gray

#### Content:
- [ yes ] Heading: "How many tokens?"
- [ yes ] Subtext mentions ticker name and fixed price (no slippage)
- [ yes ] Amount input field visible
- [ yes ] Input field pre-filled with **1000**
- [ yes ] "max" button visible next to input label
- [ yes ] Shows "X left · max" text (X = remaining tokens)

#### Price Preview:
- [ yes ] "Price per token" row shows sats
- [ yes ] "Total cost" row shows calculated sats (amount × price)
- [ yes ] Total cost is bold, gold color
- [ yes ] Updates live as you type in amount field

#### Amount Input Validation:

**Type "0" in amount field, click "Continue":**
- [ yes ] Error message: "Enter an amount greater than 0"
- [ yes ] Modal stays on Step 2
- [ yes ] Button doesn't advance

**Type "999999999" (more than remaining), click "Continue":**
- [ yes ] Error message: "Only X tokens remaining" (X = actual remaining)
- [ yes ] Modal stays on Step 2

**Click "max" button:**
- [ yes ] Amount field fills with remaining tokens
- [ yes ] Total cost updates
- [ yes ] No error message

**Type valid amount (e.g., 1000), click "Continue":**
- [ yes ] Error clears (if any)
- [ yes ] Modal advances to Step 3

### 3.5 STEP 3: Confirm Purchase

#### Step Indicator:
- [ yes ] Third dot is gold (active)
- [ yes ] First two dots are teal (completed)

#### Content:
- [ yes ] Heading: "Confirm Purchase"
- [ yes ] Subtext: "Review your purchase details. Price is locked—no front-running, no slippage."

#### Summary Card:
- [ yes ] "You pay" row shows total sats
- [ yes ] Down arrow icon centered
- [ yes ] "You get" row shows token amount + ticker (gold color)
- [ yes ] Details section below with:
  - [ yes ] "Price" shows sats/token
  - [ yes ] "Network" shows "BSV Mainnet"
  - [ yes ] "Finality" shows "Instant" (teal color)

#### Buttons:
- [ yes ] "Back" button (secondary, left)
- [ yes ] "Confirm Purchase" button (primary, right)

**Click "Back":**
- [ yes ] Modal returns to Step 2 (Amount Input)
- [ ]yes  Previous amount still filled in
- [ yes ] Step indicator updates (second dot gold)

**Return to Step 3, click "Confirm Purchase":**
- [ no ] Modal advances to Step 4
- Comment: this sale has no payout address configured yet


### 3.6 STEP 4: Processing

#### Step Indicator:
- [ ] Fourth dot is gold (active)
- [ ] First three dots are teal

#### Content:
- [ ] Heading: "Processing..."
- [ ] Spinning gold icon (loading spinner)
- [ ] Status text below spinner

#### Status Updates (watch in real-time):
**First status:**
- [ ] "Reserving tokens..."
- [ ] Brief pause (backend reserves order)

**Second status:**
- [ ] "Creating payment transaction..."
- [ ] BSV Desktop wallet prompts for signature
- [ ] Wallet shows transaction details (output address, amount)

**Sign transaction in wallet:**
- [ ] Click "Sign" in BSV Desktop
- [ ] Transaction broadcasts to mainnet

**Third status:**
- [ ] "Confirming payment..."
- [ ] Backend verifies payment txid

**Success:**
- [ ] Modal advances to Step 5 automatically

#### Error Handling (optional test):
**Reject signature in wallet:**
- [ ] Error message displays in modal
- [ ] Modal stays on Step 4 (doesn't advance)
- [ ] Error text shows wallet rejection reason

### 3.7 STEP 5: Success

#### Step Indicator:
- [ ] Fifth dot is gold (active)
- [ ] All previous dots are teal (completed)

#### Content:
- [ ] Heading: "Purchase Complete!"
- [ ] Green checkmark icon
- [ ] Subtext: "Your order is placed and pending settlement. Tokens will be delivered to your wallet once the operator processes the queue."

#### Summary Card:
- [ ] "Tokens" row shows amount + ticker
- [ ] "Paid" row shows sats
- [ ] "Payment TX" row shows txid (truncated)
  - [ ] Txid is clickable link
  - [ ] Link format: `XXXXXXXX...XXXXXXXX ↗`
  - [ ] Click link → opens WhatsOnChain in new tab
  - [ ] WhatsOnChain shows transaction details

#### Buttons:
- [ ] "Download SPV Proof (.beef)" button (secondary, with download icon)
- [ ] "Done" button (primary)
- [ ] "View Portfolio →" link (small, underlined, below buttons)

**Click "Download SPV Proof (.beef)":**
- [ ] Button shows loading state ("Downloading proof..." with spinner)
- [ ] `.beef` file downloads to Downloads folder
- [ ] Filename format: `launchpad-TICKER-payment-TXID.beef`
- [ ] File size > 0 bytes (not empty)
- [ ] Button returns to normal state after download

**If download fails (optional test - disconnect internet):**
- [ ] Error message displays below button (red text)
- [ ] "Could not download proof" or similar

**Click "View Portfolio →":**
- [ ] Browser navigates to `/portfolio`
- [ ] Modal closes

**Click "Done":**
- [ ] Modal closes
- [ ] Returns to project detail page

#### Modal Close & Reset:
**Re-open modal (click "Buy on mainnet" again):**
- [ ] Modal resets to Step 1 (or Step 2 if wallet still connected)
- [ ] Previous purchase data cleared
- [ ] Amount field resets to 1000

**Issue notes**:
```
Cannot continue from step 3 as it is not confugured yet
```

---

## TEST 4: PORTFOLIO PAGE (`/portfolio`)

### 4.1 Access Portfolio
**Navigate to http://localhost:3000/portfolio** (or click "Portfolio" in header)

### 4.2 Wallet Connection Gate (if wallet NOT connected)

#### Initial State:
- [ yes ] Page loads without errors
- [ yes ] Header shows: "Your holdings" (gold text)
- [ yes ] Heading: "Portfolio"
- [ yes ] Subtext: "View your token holdings and purchase history. All transactions are SPV-verifiable on mainnet."
- [ yes ] Connection prompt visible (centered card)
  - [ yes ] Heading: "Connect your wallet"
  - [ yes ] Subtext: "Connect your BSV Desktop wallet to view your portfolio. Your keys never leave your wallet."
  - [ yes ] "Connect Wallet" button (primary)

**Click "Connect Wallet":**
- [ no ] BSV Desktop prompts for connection
- [ no ] After approval, page loads portfolio content
- [ no ] Connection gate disappears
- Comment: no conection aproval, it just connects

### 4.3 Connected State

#### Header Section:
- [ yes ] "Your holdings" label visible
- [ yes ] "Portfolio" heading visible
- [ yes ] Subtext about SPV verification visible
- [ yes ] **Identity key display**: "Identity: XXXXXXXX...XXXXXXXX"
  - [ yes ] Identity key is truncated (first 8 + last 8 chars)
  - [ yes ] Key is in rounded gray background box

#### Tab Structure:
- [ yes ] Two tabs visible: Holdings, History
- [ yes ] **Holdings tab is active by default**
- [ yes ] Tab indicator shows active state

### 4.4 Holdings Tab (Empty State)

**If no settled orders yet:**
- [ yes ] Empty state card displays (centered)
- [ yes ] Heading: "No tokens yet"
- [ yes ] Text: "Your delivered tokens will appear here. Explore sales to get started."
- [ yes ] "Explore sales →" link visible
- [ yess ] Click link → navigates to `/#explore` (landing page)

### 4.5 Holdings Tab (With Tokens)

**After purchasing + admin settles order:**

#### Loading State:
- [ yes ] **Skeleton loaders display** while fetching
- [ yes ] 3 skeleton cards visible (pulsing gray rectangles)
- [ yes ] Skeleton has: circle (logo), 2 bars (name/amount)
- [ yes ] After fetch completes, skeletons replaced with real data
- Comment: Skelleton dissapears too quickly, make it smoother

#### Token Cards:
**For each holding:**
- [ ] Card displays with border, padding
- [ ] Token logo visible (or placeholder with ticker initials)
- [ ] Token name visible (e.g., "Meridian Token")
- [ ] Ticker visible in gray (e.g., "MER")
- [ ] Amount visible in large gold font: "X,XXX tokens"
  - [ ] Number is formatted with commas (1,000 not 1000)
- [ ] "Latest delivery:" label with txid link
  - [ ] Txid format: `XXXXXXXX...XXXXXXXX ↗`
  - [ ] Click link → opens WhatsOnChain in new tab
  - [ ] WhatsOnChain shows delivery transaction
- [ ] "View project" button (right side)
  - [ ] Click → navigates to `/sale/[slug]`
- Comment: will see when i have holdings

#### Multiple Holdings:
**If bought multiple different tokens:**
- [ ] Each token has separate card
- [ ] Cards stacked vertically
- Comment: will see when i have holdings

**If bought same token multiple times:**
- [ ] Single card displays
- [ ] Amounts are summed correctly
- [ ] Latest txid is most recent delivery
- Comment: will see when i have holdings

### 4.6 History Tab

**Click "History" tab:**
- [ yes ] Tab becomes active
- [ yes ] Holdings content hidden

#### Empty State (no orders):
- [ yes ] Empty state card displays
- [ yes ] Heading: "No orders yet"
- [ yes ] Text: "Your purchase history will appear here."
- [ yes ] "Explore sales →" link visible

#### Loading State (with orders):
- [ yes ] **Skeleton loaders display** while fetching
- [ yes ] 3 skeleton cards visible (mobile) or loading indicator (desktop)
- [ yes ] After fetch, skeletons replaced with real data
- Skelleton dissapears too quickly, make it smoother

#### Desktop View (≥1024px width)

**Table Structure:**
- [ yes ] Table visible (not cards)
- [ yes ] 6 columns: Date, Token, Amount, Paid (sats), Status, Proof
- [ yes ] Header row with column labels (uppercase, small, gray)

**For each order row:**
- [ yes ] Date column shows: "Mon DD, YYYY" format (e.g., "Aug 24, 2026")
- [ yes ] Token column shows:
  - [ yes ] Logo (or placeholder)
  - [ yes ] Token name (clickable link to project)
  - [ yes ] Ticker in gray below name
- [ yes ] Amount column shows: "X,XXX" (right-aligned, tabular)
- [ yes ] Paid column shows: "X,XXX" sats (right-aligned, tabular)
- [ yes ] Status column shows status pill (e.g., "pending", "settled")
  - [ yes ] Pill color matches status (pending = yellow, settled = teal, failed = red)
- [ yes ] Proof column shows links:
  - [ yes ] "Pay ↗" link (payment txid) - always visible
  - [ yes ] "Delivery ↗" link (delivery txid) - only if settled
  - [ yes ] Both links open WhatsOnChain in new tab

**Click token name:**
- [ yes ] Navigates to `/sale/[slug]`

**Click "Pay ↗":**
- [ yes ] Opens WhatsOnChain with payment txid
- [ yes ] Transaction shows your payment to sale payout address

**Click "Delivery ↗" (if settled):**
- [ yes ] Opens WhatsOnChain with delivery txid
- [ yes ] Transaction shows STAS tokens delivered to your address

#### Mobile View (<1024px width)

**Resize browser to <1024px:**
- [ yes ] Table disappears
- [ yes ] **Card layout displays instead**

**For each order card:**
- [ yes ] Card has border, padding, rounded corners
- [ yes ] Top row shows:
- [ yes ] Top row shows:
  - [ yes ] Token logo + name + ticker (left)
  - [ yes ] Status pill (right)
- [ yes ] 2-column grid below:
  - [ yes ] "Amount" label + value
  - [ yes ] "Paid" label + value (sats)
  - [ yes ] "Date" label + formatted date
  - [ yes ] "Proof" label + links ("Pay ↗" + "Delivery ↗")
- [ yes ] All text readable, no overflow
- [ yes ] Cards stack vertically

**Resize back to >1024px:**
- [ yes ] Cards disappear
- [ yes ] Table displays again

### 4.7 Responsive Testing

**Test at these widths:**

#### 1920px (Large Desktop):
- [ yes ] Holdings: Cards display with full width
- [ yes ] History: Table shows all 6 columns clearly

#### 1440px (Laptop):
- [ yes ] Same as 1920px

#### 1024px (Tablet landscape):
- [ yes ] History: Table still visible
- [ yes ] All columns fit

#### 1023px (Just below breakpoint):
- [ yes ] History: **Cards display, not table**
- [ yes ] Layout switches smoothly

#### 768px (Tablet portrait):
- [ yes ] Holdings: Cards full width
- [ yes ] History: Cards stack vertically
- [ yes ] No horizontal scroll

#### 375px (Mobile):
- [ yes ] All content visible
- [ yes ] Text doesn't overflow
- [ yes ] Buttons remain clickable
- [ yes ] No horizontal scroll

**Issue notes**:
```
Tabs in all places where a scroll happens because of size, the scrollbar is default and not in style with the rest of the page
```

---

## TEST 5: NAVIGATION & ROUTING

### 5.1 Header Navigation

**From any page, test each nav link:**

#### Click "Explore":
- [ yes ] Navigates to `/#explore` (landing page, scrolls to explore section)
- [ yes ] Page doesn't reload (smooth scroll if on homepage)

#### Click "Portfolio":
- [ yes ] Navigates to `/portfolio`
- [ yes ] If wallet not connected, shows connection gate
- [ yes ] If wallet connected, shows portfolio tabs

#### Click "Submit":
- [ yes ] Navigates to `/submit`
- [ yes ] Form or submission page loads

#### Click "Docs":
- [ yes ] Currently links to `#` (placeholder)
- [ yes ] Page doesn't navigate (or shows "coming soon")

#### Click "BSV Launchpad" logo:
- [ yes ] Navigates to `/` (homepage)
- [ yes ] Landing page loads

### 5.2 Wallet Button

**If wallet NOT connected:**
- [ yes ] Button shows "Connect Wallet"
- [ no ] Click button → BSV Desktop prompts
- [ yes ] After connection, button updates

**If wallet connected:**
- [ yes ] Button shows truncated identity key or "Connected"
- [ yes ] (Optional: If disconnect implemented, clicking shows disconnect option)

### 5.3 Mobile Menu

**Resize to <640px:**
- [ yes ] Hamburger icon visible (3 horizontal lines)
- [ yes ] Click icon → menu slides in
- [ yes ] Menu shows: Explore, Portfolio, Submit, Docs
- [ yes ] Click any link → navigates + menu closes
- [ yes ] Click outside menu → menu closes

### 5.4 Browser Navigation

**Click browser back button:**
- [ yes ] Returns to previous page
- [ yes ] State preserved (no data loss)

**Click browser forward button:**
- [ yes ] Goes forward in history

**Refresh page (Cmd+R / Ctrl+R):**
- [ yes ] Page reloads
- [ yes ] Wallet connection persists (if previously connected)
- [ yes ] No errors in console

**Issue notes**:
```
[Write any issues here]
```

---

## TEST 6: ERROR HANDLING

### 6.1 Network Errors

**Disconnect internet, then:**

#### Try to load landing page:
- [ yes ] Page shows error or retry prompt
- [ yes ] No infinite loading spinner

#### Try to fetch portfolio:
- [ yes ] Error message displays
- [ yes ] Not just skeleton loaders forever

#### Try to buy tokens:
- [ yes ] Modal shows error when payment tx fails to broadcast
- [ yes ] Error message is readable (not "Network Error 500")

**Reconnect internet:**
- [ yes ] Retry works (page loads)

### 6.2 Wallet Disconnection

**Disconnect wallet (close BSV Desktop or revoke connection):**

#### Navigate to Portfolio:
- [ yes ] Shows "Connect your wallet" gate
- [ yes ] Doesn't show stale data

#### Try to buy tokens:
- [ yes ] Modal shows Step 1 (Connect)
- [ yes ] Doesn't attempt to create transaction

### 6.3 Invalid Routes

**Navigate to http://localhost:3000/invalid-page:**
- [ yes ] 404 page displays
- [ yes ] Header/footer still visible
- [ yes ]  "Go home" or similar link available

**Navigate to http://localhost:3000/sale/does-not-exist:**
- [ yes ] Shows "Project not found" or 404
- [ yes ] Doesn't crash

**Issue notes**:
```
[Write any issues here]
```

---

## TEST 7: PERFORMANCE

### 7.1 Page Load Times

**Open Chrome DevTools Network tab:**

#### Landing page (`/`):
- [ yes ] Initial load < 2 seconds
- [ yes ] No console errors
- [ yes ] No 404s for assets

#### Project detail page (`/sale/[slug]`):
- [ yes ] Load < 2 seconds
- [ yes ] Images load progressively (if large)

#### Portfolio page (`/portfolio`):
- [ yes ] Skeleton loaders appear immediately
- [ yes ] Data loads < 1 second (with local DB)

### 7.2 Skeleton Loaders

**Check skeleton timing:**
- [ yes ] Skeletons appear **immediately** (not after 500ms delay)
- [ yes ] Smooth transition from skeleton → real data (no flash)
- [ yes ] No "flash of empty content"

### 7.3 Modal Performance

**Open Buy Modal:**
- [ yes ] Opens instantly (no lag)
- [ yes ] Step transitions are smooth (no janky animations)

### 7.4 Mobile Performance

**On mobile device or DevTools mobile emulation:**
- [ yes ] Scroll is smooth (60fps)
- [ yes ] Tap targets are large enough (buttons not tiny)
- [ yes ] No accidental taps on wrong elements

**Issue notes**:
```
Make a custom 404 page for the launchpad
```

---

## TEST 8: ACCESSIBILITY

### 8.1 Keyboard Navigation

**Tab through landing page:**
- [ yes ] Logo is focusable
- [ yes ] Nav links are focusable
- [ yes ] Wallet button is focusable
- [ yes ] Filter tabs are focusable
- [ yes ] Project cards are focusable
- [ yes ] Focus indicator visible (outline or highlight)
- [ yes ] Tab order is logical (top to bottom, left to right)

**In Buy Modal:**
- [ yes ] Can tab to Close (X) button
- [ yes ] Can tab to primary action button
- [ yes ] Can tab to "Back" button (if present)
- [ yes ] Press Escape → modal closes

**In Portfolio:**
- [ yes ] Table rows are focusable
- [ yes ] Links (WoC, project) are focusable
- [ yes ] Tab navigation works

### 8.2 Screen Reader (Optional)

**Enable VoiceOver (Mac) or NVDA (Windows):**
- [ ] All buttons announce their label
- [ ] Images have alt text (or aria-label)
- [ ] Status pills announce state
- [ ] Links announce destination

### 8.3 Color Contrast

**Check key text:**
- [ ] Body text on background has sufficient contrast
- [ ] Button text on button background is readable
- [ ] Gold text on white is readable
- [ ] Muted text is still readable (not too light)

**Issue notes**:
```
[Write any issues here]
```

---

## TEST 9: CROSS-BROWSER (Optional)

### 9.1 Chrome/Edge (Chromium)
- [ ] All features work
- [ ] No console errors

### 9.2 Firefox
- [ ] All features work
- [ ] No console errors
- [ ] Layout matches Chrome

### 9.3 Safari
- [ ] All features work
- [ ] No console errors
- [ ] Webkit-specific issues (if any)

**Issue notes**:
```
Alll yes
```

---

## TEST 10: SPV VERIFICATION (Advanced)

### 10.1 BEEF File Download

**After purchasing, download `.beef` file:**
- [ ] File exists in Downloads folder
- [ ] Filename: `launchpad-TICKER-payment-XXXXXXXX.beef`
- [ ] File size > 0 bytes

### 10.2 BEEF Parsing (Requires BSV SDK)

**Optional: Verify BEEF contents:**
```bash
# Example using Node.js REPL
const { readFileSync } = require('fs');
const { Transaction } = require('@bsv/sdk');

const beef = readFileSync('/path/to/launchpad-BT5-payment-XXXXXXXX.beef');
const tx = Transaction.fromBEEF(beef);
console.log(tx.id('hex')); // Should match txid from modal
```

- [ ] BEEF parses without errors
- [ ] Transaction ID matches payment txid
- [ ] Transaction has merkle proof

### 10.3 WhatsOnChain Verification

**For payment txid:**
- [ ] Open link from Portfolio History "Pay ↗"
- [ ] WhatsOnChain shows transaction
- [ ] Transaction has outputs to sale payout address
- [ ] Amount matches sats paid

**For delivery txid (after settlement):**
- [ ] Open link from Portfolio History "Delivery ↗"
- [ ] WhatsOnChain shows transaction
- [ ] Transaction outputs include STAS token UTXO
- [ ] Your receive address is in outputs

**Issue notes**:
```
This will be tackled in a separate sectin
submit for review works wven if sale terms are not set
issuance of token works on manage
save presale terms in bonding curve makes the pool and mint transactions
buying does not work
```

---

## SUMMARY REPORT

**Total tests**: ~200+

**Passed**: _____ / _____

**Failed**: _____ / _____

**Critical issues** (blocks core functionality):
```
[List P0 bugs here]
```

**Minor issues** (polish/nice-to-have):
```
[List P1/P2 issues here]
```

**Browser tested**:
- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari

**Device tested**:
- [ ] Desktop (1920px)
- [ ] Laptop (1440px)
- [ ] Tablet (1024px, 768px)
- [ ] Mobile (375px)

**Overall assessment**:
- [ ] ✅ Ready for production
- [ ] ⚠️ Needs fixes before production
- [ ] ❌ Major blockers present

---

## NEXT STEPS

**If all tests pass**:
1. Deploy to production
2. Monitor for runtime issues
3. Gather user feedback

**If issues found**:
1. Document all failures above
2. Prioritize: P0 (critical) → P1 (important) → P2 (nice-to-have)
3. Fix P0 issues before deploying
4. Create GitHub issues for P1/P2

---

**Testing completed by**: ______________

**Date**: ______________

**Time spent**: _________ hours
