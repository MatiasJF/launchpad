# Launch Guide: Sale Types & On-Chain Testing

**Purpose:** Understand what each sale type does, which are production-ready, and how to test them end-to-end on BSV mainnet.

**Last updated:** 2026-08-24 (after UX-first 4-week sprint)

---

## Overview: Three Sale Types

The launchpad supports three distinct sale mechanisms, each with different trust models and on-chain mechanics:

| Type | Status | On-Chain Proven | Production Ready | Trust Model |
|------|--------|----------------|------------------|-------------|
| **Instant Swap** | ✅ Verified | Yes (tx `73d34b30…`) | **YES** | Operator-settled (liveness trust) |
| **Bonding Curve (Linear)** | ✅ Verified | Yes (tx `6bcdbb97…`) | **YES** | Non-custodial buy (sell TODO) |
| **Bonding Curve (Ledger)** | ✅ Code-complete | Partial (buy only) | **NO** - Need sell mainnet test | Fully trustless |
| **Bonding Curve (STAS)** | ⚠️ Built | Yes (full loop) | **NO** - SELL DRAIN FIXES NEEDED | Hybrid (operator-gated sells) |
| **Escrow Presale** | 🏗️ Built | No | **NO** - Live test pending | Trustless pledges, operator delivery |

---

## 1. Instant Swap (Fixed-Price Sale)

### What It Is
- Owner sets a **fixed price** (e.g., 100 sats/token)
- Buyer pays → operator delivers tokens
- Simple, proven, **ready for production**

### On-Chain Proof
- **Full loop verified** (STATE.md line 664-798)
- Buy tx: `73d34b30…` (100 tokens → buyer `13HGL9BfmT1G…`)
- Settlement: 2-tx engine (funding + transfer)
- SPV: BEEF download works

### Trust Model
- **Operator liveness** - operator must be running to settle
- **No price manipulation** - price is fixed at sale creation
- **Non-custodial** - buyer/seller wallets sign their own txs

### How to Launch

#### Step 1: Create Project (Owner)
1. Navigate to `/submit`
2. Connect wallet (BSV Desktop)
3. Fill form:
   - Name, ticker, description (Markdown)
   - Logo URL (https:// PNG/JPG/WEBP)
   - Banner URL (optional)
   - Payout address (where buyer payments go)
4. Submit → project created as `pending`

#### Step 2: Approve Project (Admin)
1. Navigate to `/admin`
2. Enter admin password: `launchpad-admin` (from `.env.local`)
3. Find pending project
4. Click "Approve" → status: `approved`

#### Step 3: Issue Tokens (Owner)
1. Navigate to `/project/{slug}/manage`
2. **Issue Token** section:
   - Supply: e.g., 10,000
   - Click "Issue STAS Token"
   - Wallet prompts for 2 txs:
     - TX1: Contract (locks supply to tokenId)
     - TX2: Issue (mints genuine STAS)
   - Sign both → issuance recorded
3. **Verify:** Check WhatsOnChain - should show "authentic" back-to-genesis

#### Step 4: Configure Sale (Owner)
1. Still in `/project/{slug}/manage`
2. **Sale Details** tab:
   - Type: `instant_swap`
   - Price: e.g., 100 sats/token
   - Allocation: e.g., 5,000 tokens
   - Save
3. **Schedule** tab:
   - Status: `live`
   - Start time: now (or future)
   - End time: optional
   - Save

#### Step 5: Buy (Buyer)
1. Navigate to `/sale/{slug}`
2. Click "Buy on mainnet"
3. Modal flow (5 steps):
   - Connect wallet
   - Enter amount (e.g., 100 tokens)
   - Confirm purchase
   - Sign payment tx (wallet prompt)
   - Download SPV proof (.beef file)
4. **Result:** Order created as `pending`, payment tx on-chain

#### Step 6: Settle Order (Owner/Operator)
1. Navigate to `/project/{slug}/manage` → **Orders** tab
2. Find pending order
3. Click "Settle Order"
4. Operator backend:
   - Builds 2-tx transfer (funding + STAS delivery)
   - Broadcasts to mainnet
   - Stamps order as `settled`
5. **Verify:** Buyer sees tokens in `/portfolio` → Holdings tab

#### Step 7: Buyer Registers Tokens (Buyer)
1. Navigate to `/sale/{slug}`
2. Scroll to "Check my orders"
3. Find settled order
4. Click "Register in wallet"
5. **Result:** Tokens now tracked in BSV Desktop, spendable

### Known Limitations
- **Manual settlement** - owner must click "Settle Order" (no auto-queue yet)
- **Operator liveness** - if operator offline, deliveries stall
- **No batching UI** - one order at a time (batch function exists, not wired)

---

## 2. Bonding Curve (Linear) - Buy-Only

### What It Is
- **Non-custodial AMM** - buyers buy directly from an on-chain covenant
- Price increases linearly: `cost = k × delta × (2×sold + delta + 1) / 2`
- **No signature** on covenant input - trustless price enforcement
- **Sell not implemented** (linear curve is buy-only demonstration)

### On-Chain Proof
- **Deploy + buy verified** (STATE.md line 545-583)
- Deploy: `71407ee6…` (covenant count=0)
- Buy: `6bcdbb97…` spends covenant with **NO signature**
  - 1877-byte pushed preimage (OP_PUSH_TX)
  - Reserve: 546→561 sats (cost 15 = exact `5×6/2`)
  - Successor re-locks byte-identically (sold=5)

### Trust Model
- **Fully trustless** - covenant enforces price on-chain
- **No operator** - anyone can buy by building the covenant unlock
- **Self-replicating** - successor script advances state (sold++)

### How to Launch

#### Step 1-3: Same as Instant Swap
(Create project → approve → issue tokens)

#### Step 4: Deploy Curve (Owner)
1. Navigate to `/project/{slug}/manage` → **Presale** tab
2. **Bonding Curve** section:
   - Type: `bonding_curve`
   - Variant: `linear`
   - k: 1 (curve steepness, hardcoded for now)
   - Supply: 1000 (hardcoded for now)
3. Click "Deploy Linear Curve"
4. Wallet prompts to seed reserve covenant
5. Sign → covenant deployed on-chain
6. **Verify:** WhatsOnChain shows covenant UTXO

#### Step 5: Buy from Curve (Buyer)
1. Navigate to `/sale/{slug}`
2. Curve buy card shows:
   - Current price (increases with sold)
   - Reserve balance
   - Tokens sold / supply
3. Enter amount (e.g., 10 tokens)
4. Click "Buy on curve"
5. Wallet prompts for payment
6. **TX structure:**
   - Input 0: Covenant (pushed delta/newReserve/preimage, **NO SIG**)
   - Input 1: Buyer payment (SIGHASH_ALL)
   - Output 0: Successor covenant @ newReserve
   - Output 1: 546-sat token receipt to buyer
7. Sign → tx broadcasts
8. **Result:** Curve advances, buyer gets receipt

### Known Limitations
- **Buy-only** - no sell mechanism (sell would need ledger or STAS variant)
- **Fixed params** - k=1, supply=1000 hardcoded (runtime script-gen TODO)
- **546-sat receipts** - tokens are dust UTXOs, not wallet-integrated STAS

---

## 3. Bonding Curve (Ledger) - Two-Way Trustless

### What It Is
- **In-covenant ledger** - balances live in `HashedMap<ownerPkh, amount>`
- Buy **credits** ledger, sell **debits** with holder signature
- **No forgeable token** - reserve is drain-proof
- **Fully trustless** - covenant enforces accounting

### On-Chain Proof
- **Buy verified** (STATE.md line 469-528)
- Buy: `ca6692f6…` / `0954a7c2…`
- Sell: `62ab6894…` (−1) / `6cea3e69…` (−5)
- Ledger state tracked correctly on-chain

### Trust Model
- **Zero trust** - covenant enforces price + accounting
- **Non-custodial** - holder signs sells with derived key
- **No operator key** - fully decentralized

### How to Launch

⚠️ **NOT PRODUCTION-READY** - sell needs mainnet test

#### Step 1-3: Same as Instant Swap

#### Step 4: Build Ledger Service
**CRITICAL:** Must compile scrypt-ts service before deploying:

```bash
cd packages/curve
pnpm build:service
# Creates service/dist/service/cli.js (gitignored)
```

This service runs scrypt-ts **server-side** (Next.js child process) to compute covenant unlocks.

#### Step 5: Deploy Ledger Curve (Owner)
1. Navigate to `/project/{slug}/manage` → **Presale** tab
2. **Bonding Curve** section:
   - Type: `bonding_curve`
   - Variant: `ledger`
   - k: 1, supply: 1000 (same as linear)
   - Payout pkh: derived from project payout address
3. Click "Deploy Ledger Curve"
4. Wallet prompts to seed covenant
5. **Covenant structure:**
   - State: `HashedMap<ownerPkh, amount>` (starts empty)
   - `buy()`: credits ledger (ANYONECANPAY_SINGLE)
   - `sell()`: debits with owner sig (ANYONECANPAY_ALL)
6. Sign → deployed

#### Step 6: Buy (Buyer)
1. Navigate to `/sale/{slug}` → `LedgerTradeCard`
2. **Buy tab:**
   - Enter amount
   - Shows curve cost
3. Click "Buy"
4. Backend:
   - Calls `ledger-service.ts` (child process)
   - scrypt-ts computes unlock (`getUnlockingScript`)
   - @bsv/sdk validates it
5. **TX structure:**
   - Input 0: Covenant (scrypt-ts unlock + access path)
   - Input 1: Buyer payment
   - Output 0: Successor (ledger updated: buyer balance += delta)
6. Sign → broadcasts
7. **Result:** Buyer's balance in ledger, no STAS token yet

#### Step 7: Sell (Buyer)
⚠️ **NEEDS MAINNET TEST** - only tested offline

1. Still in `/sale/{slug}` → **Sell tab**
2. Enter amount to sell
3. Click "Sell"
4. Backend computes sell unlock
5. Buyer signs digest with derived key (`createSignature`)
6. **TX structure:**
   - Input 0: Covenant (sell unlock + holder sig)
   - Input 1: Operator fee input
   - Output 0: Successor (ledger debited: buyer −= delta)
   - Output 1: Refund to buyer @ curve price
7. Broadcast → ledger decrements

### Known Limitations
- **Sell untested on mainnet** - offline tests pass (13/13), needs live run
- **No STAS tokens** - balances are ledger entries until "graduation"
- **Graduation TODO** - once sold out, release reserve + mint real STAS
- **Fixed params** - k/supply hardcoded

---

## 4. Bonding Curve (STAS) - Wallet-Held Tokens

### What It Is
- **Hybrid model** - buyers get **real STAS tokens in their wallet**
- Buy: Reserve buy (covenant) + operator STAS delivery
- Sell: Return STAS to vault + operator refund
- **Operator-gated sells** - operator must verify + co-sign

### On-Chain Proof
- **Full loop verified** (STATE.md line 171-187)
- Mint: `34e2d40b…`
- Delivery: `fe149176…` (1 STAS → buyer, 2 → vault change, BSV → base)
- Return: `f7165b98…`
- Refund: `caf36b55…`
- **Back-to-genesis:** `authentic: true`

### Trust Model
- **Operator liveness** - operator must deliver/refund
- **Reserve-critical operator key** - compromised key can drain reserve
- **Drain-proof vs malicious users** - covenant caps refunds, provenance verified

### Critical Issues ⚠️

**DO NOT SHIP SELL** until these 3 fixes are applied (STATE.md lines 312-390):

1. ⛔ **CRITICAL: Double-refund replay** (FIXED 2026-07-31)
   - **Risk:** One STAS return → N refunds → reserve drained
   - **Fix:** `Order.sellReturnOutpoint` unique + `isOutputUnspent` check
   - **Status:** CLOSED (migration applied, re-check enforced)

2. ⛔ **CRITICAL: Existence-only back-to-genesis** (FIXED 2026-07-31)
   - **Risk:** 1 genuine + 1 counterfeit merged → passes B2G → over-refund
   - **Fix:** Full provenance walk (`provenanceWalk`) - EVERY input to issuance
   - **Status:** CLOSED (17/17 tests, counterfeit merge REJECTED)

3. ⚠️ **Payee not covenant-bound** (ACCEPTED as operator-trust)
   - **Risk:** Compromised operator redirects refund to itself
   - **Status:** MOOT - operator key already reserve-critical

### How to Launch

⚠️ **REVIEW FIXES FIRST** - verify migrations + tests before enabling

#### Step 1-3: Same as Instant Swap

#### Step 4: Deploy STAS Curve (Owner)
1. Navigate to `/project/{slug}/manage` → **Bonding Curve** section
2. **STAS Pool** area:
   - k: 1 (default)
   - Supply: 5 (small for cheap testing)
   - Click "Create STAS Pool"
3. Wallet prompts to deploy reserve covenant
4. Sign → covenant deployed (bakes operator pkh)
5. **Mint to vault:**
   - Click "Mint supply to operator vault"
   - Wallet signs CONTRACT → ISSUE genesis
   - Supply locks to operator vault (owner pubkey override)
6. **Verify:** issuance recorded, vault holds full supply

#### Step 5: Buy (Buyer)
1. Navigate to `/sale/{slug}` → `StasTradeCard` → **Buy tab**
2. Enter amount (e.g., 2 tokens)
3. Click "Buy on curve"
4. **TX-A "reserve buy"** (client-assembled):
   - Input 0: Covenant BUY (0xc3; pushed delta/newReserve/preimage + `00` selector)
   - Input 1: Buyer payment (SIGHASH_ALL - anti-shortchange)
   - Output 0: Successor @ newReserve
5. Wallet signs input 1 → TX-A broadcasts
6. **TX-B "STAS delivery"** (operator backend):
   - Resolves current vault UTXO
   - Builds transfer: vault → buyer (delta) + change to vault
   - Operator signs vault input (flat key callback)
   - Broadcasts TX-B
7. **Result:** Buyer gets real STAS, vault moves

#### Step 6: Sell (Buyer)
⚠️ **VERIFY FIX-1 + FIX-2 BEFORE USING**

1. Still in `StasTradeCard` → **Sell tab**
2. Shows buyer's held STAS (from deliveries)
3. Enter amount to sell (must be ≤ single holding, no aggregation)
4. **TX1 "STAS return"** (client wallet transfer):
   - Buyer transfers delta STAS to operator vault
   - Derivation: `{protocolID: STAS, keyID: slug, counterparty:'self', forSelf:false}`
   - Change STAS back to self
5. Sign → TX1 broadcasts
6. Click "Finalize Sell"
7. **TX2 "reserve refund"** (operator):
   - Runs `verifyStasBackToGenesis` (full provenance walk)
   - Builds refund: covenant SELL input (0xc1) + fee input
   - Operator co-signs covenant
   - Output 0: Successor (reserve −= refund)
   - Output 1: Refund to seller @ curve price
8. **Result:** Seller gets sats back, pool decrements

### Known Limitations
- **Manual finalize** - buyer clicks "Finalize Sell" (no auto-trigger on TX1)
- **Single-holding sell** - must sell from one UTXO (no cross-UTXO aggregation)
- **Stuck refund recovery** - "Complete refund" button for failed finalizes

---

## 5. Escrow Presale (Soft-Cap Crowdfund)

### What It Is
- **SIGHASH_ANYONECANPAY dominant-assurance** contract
- Contributors **pledge** (funds stay in their wallet, tx unsigned)
- Once soft cap met → owner **assembles** (combines pledges → one tx)
- Broadcasts → pledges become orders → normal settlement

### On-Chain Proof
- **Built, not tested live** (STATE.md lines 857-882)
- Verified offline: `0xC1` pledge signed alone validates after other inputs join

### Trust Model
- **Trustless intake** - pledges don't leave wallet until assembled
- **Trustless refund** - spend the UTXO anytime before assembly
- **NOT trustless delivery** - operator settles (classic STAS limitation)

### How to Launch

⚠️ **LIVE TEST PENDING** - no mainnet proof yet

#### Step 1-3: Same as Instant Swap

#### Step 4: Configure Escrow (Owner)
1. Navigate to `/project/{slug}/manage` → **Presale** tab
2. **Escrow Presale** section:
   - Type: `escrow_presale`
   - Soft cap: e.g., 50,000 sats (minimum to proceed)
   - Hard cap: e.g., 100,000 sats (maximum)
   - Pledge unit: e.g., 1,000 sats (minimum contribution)
   - Price: sats/token
3. Save → sale configured as `escrow_presale`

#### Step 5: Pledge (Contributors)
1. Navigate to `/sale/{slug}` → `ContributeCard`
2. Shows:
   - Soft cap progress bar
   - Hard cap limit
   - Pledge unit (minimum)
3. Enter amount (must be multiple of pledge unit)
4. Click "Pledge"
5. **createPledge:**
   - Mints exact-value UTXO (e.g., 5,000 sats)
   - Signs with SIGHASH_ANYONECANPAY (0xC1)
   - **Does NOT broadcast** - just stores signed tx
6. **Result:** Pledge recorded as `pledged`, funds still in wallet

#### Step 6: Assemble (Owner, once soft cap met)
1. Navigate to `/project/{slug}/manage` → **Presale** tab
2. "✓ Soft cap funded" indicator appears
3. Click "Assemble Presale"
4. **assembleAssuranceTx:**
   - Combines all `pledged` pledges (0xC1 inputs)
   - Adds fee input (owner)
   - Output: Exact soft-cap amount → project payout
5. Broadcast → each pledge becomes a `pending` order
6. **Result:** Contributors' funds leave wallets, orders created

#### Step 7: Instant Buy (Top-Up Phase)
Once assembled, sale switches to instant-buy mode:
- `BuyCard` replaces `ContributeCard`
- Buyers can buy remaining tokens (hard cap − soft cap)
- Normal instant-swap flow from Step 5 (Instant Swap section)

#### Step 8: Settle Orders (Owner)
Same as Instant Swap Step 6 - settle each order (or batch settle)

### Known Limitations
- **No live test** - needs mainnet run to verify assembly
- **Manual assembly** - owner must click when soft cap met
- **Emergency withdraw** - if presale fails, contributors spend their pledges manually

---

## Testing Priorities

### Immediate (Production-Ready)
1. ✅ **Instant Swap** - Full end-to-end mainnet test
2. ✅ **Linear Curve** - Buy-only mainnet test

### Near-Term (Needs Testing)
3. ⚠️ **Ledger Curve** - Mainnet sell test (buy proven)
4. ⚠️ **Escrow Presale** - First presale assembly + settlement

### Blocked (Needs Fixes)
5. ⛔ **STAS Curve Sell** - DO NOT SHIP until FIX-1 + FIX-2 verified
   - Verify `Order.sellReturnOutpoint` unique constraint
   - Test counterfeit merge rejection (`provenanceWalk`)
   - Run 17/17 offline tests
   - Then: live sell test with small amounts

---

## Common Issues & Fixes

### "Missing inputs" on broadcast
- **Cause:** TX2 spending unconfirmed TX1, WoC node hasn't seen TX1
- **Fix:** Broadcast TX1 first, then TX2 (both via `broadcastRawTx`)
- **Code:** `settle-actions.ts` + `stas-actions.ts`

### "Pool UTXO is already SPENT"
- **Cause:** Settle pointed at stale UTXO (mint instead of current pool)
- **Fix:** `resolveCurrentPool` auto-resolves latest UTXO
- **Code:** `settle-actions.ts:resolveCurrentPool`

### "Counterfeit" token on WhatsOnChain
- **Cause:** Single-output issuance (no contract ancestor)
- **Fix:** Classic contract→issue genesis (`issueStasGenesis`)
- **Code:** `packages/bsv/src/issue/genesis.ts`

### Wallet doesn't show delivered tokens
- **Cause:** Tokens on-chain but not internalized into wallet basket
- **Fix:** "Register in wallet" button → `receiveStasToken` → `internalizeAction`
- **Code:** `packages/bsv/src/receive` + `ClaimTokens.tsx`

### Settlement stuck at "settling"
- **Cause:** `transferStas` failed mid-flow, order claimed but not finalized
- **Fix:** Re-click settle (idempotent via outpoint check) or admin SQL update
- **Future:** Stale-settling sweep

### Covenant fee underpayment (evicted from mempool)
- **Cause:** Fee sized at flat 34 B/output, ignoring 3.5 KB covenant script
- **Fix:** Size from ACTUAL serialized bytes @ 0.1 sat/byte
- **Code:** `packages/curve/src/curvePool.ts:sizeCovenantTx`

### "too-long-mempool-chain" on buy/sell
- **Cause:** Operator base UTXO descends from deep unconfirmed chain (>25)
- **Fix:** `selectOperatorFeeInputs` skips deep UTXOs, fails before broadcast
- **Code:** `packages/bsv/src/settle/operatorBaseFunding.ts`

---

## Pre-Launch Checklist

### For Instant Swap (READY)
- [ ] Admin password rotated from default
- [ ] Operator wallet funded (base address has sats)
- [ ] Operator key backed up (never commit to repo)
- [ ] Test project: create → issue → buy → settle → register
- [ ] Verify BEEF download works
- [ ] Check portfolio Holdings + History tabs
- [ ] Verify WhatsOnChain links (payment + delivery)

### For Bonding Curves (REVIEW FIXES)
- [ ] `pnpm --filter @launchpad/curve build:service` (for ledger)
- [ ] Test deploy on mainnet (small k/supply for cheap test)
- [ ] Verify covenant validates in @bsv/sdk
- [ ] Check successor script byte-matches scrypt-ts
- [ ] Test buy (linear/ledger) - verify price enforcement
- [ ] **STAS ONLY:** Verify FIX-1 + FIX-2 migrations applied
- [ ] **STAS ONLY:** Run 17/17 offline tests green
- [ ] **STAS ONLY:** Test sell with DUST amounts first

### For Escrow (PENDING)
- [ ] Test pledge flow (funds stay in wallet)
- [ ] Verify 0xC1 sigs validate after assembly
- [ ] Test assembly (soft cap → one tx)
- [ ] Verify orders created from pledges
- [ ] Test instant-buy top-up phase
- [ ] Test emergency withdraw (spend pledge UTXO)

---

## Next Steps

1. **Commit scrollbar + UI fixes** ✅ DONE
2. **Create this launch guide** ✅ DONE
3. **Test Instant Swap end-to-end** (you + BSV Desktop)
4. **Document any new issues** in TEST-CHECKLIST.md
5. **Fix payout address configuration** for demo projects
6. **Test real purchase flow** with small amounts
7. **Verify SPV proof download** works
8. **Check portfolio updates** after settlement

**Ready to start testing?** Begin with Instant Swap (Step 1-7 above) on a fresh demo project.
