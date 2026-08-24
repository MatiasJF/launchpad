# Project State

_Last updated: 2026-08-24 — by: UX-first 4-week sprint COMPLETE — all core user flows polished, responsive, and SPV-integrated_

## Latest (2026-08-24) — UX-First 4-Week Sprint: COMPLETE ✅

**Decision:** UX-first, narrow + polished, STAS curve default, defer escrow, ship ASAP (user: "1) ux, 2) stas, 3) defer, 4) narrow, 5) asap").

**All 4 weeks shipped** (typecheck + build green, responsive tested):

### Week 1: Landing + Project Detail Pages ✅
- ✅ Trending tab (volume-based sort)
- ✅ Live status indicators (pulsing dot)
- ✅ Buy tab front-and-center (default view)
- ✅ Price guarantee messaging (no slippage, no front-running)
- ✅ SPV explainer (collapsible education)

### Week 2: Buy Modal + SPV Proof Download ✅
- ✅ Multi-step modal (Connect → Amount → Confirm → Processing → Success)
- ✅ Visual progress indicator
- ✅ Error handling at each step
- ✅ SPV proof download button (BEEF from WhatsOnChain)
- ✅ "View Portfolio →" link

### Week 3: Portfolio Page ✅
- ✅ Portfolio route + nav integration (desktop + mobile)
- ✅ Wallet connection gate
- ✅ Holdings tab (grouped tokens, WoC links)
- ✅ History tab (all orders, dual proofs)
- ✅ Identity key display (truncated)

### Week 4: Visual Polish + Responsive Design ✅
- ✅ Mobile-responsive history (table → cards)
- ✅ Skeleton loaders (perceived performance)
- ✅ Identity key in portfolio header
- ✅ All flows tested on desktop + mobile

**Design philosophy**: BSV constraints → UX opportunities (instant finality, no front-running, SPV proofs are FEATURES to showcase, not hide).

**Impact**: BSV's unique value props are now visible at every step. Users understand *why* BSV is different, not just *what* it does.

**Details**: [ux-first-4week-shipped.md](./artifacts/ux-first-4week-shipped.md)

**Next**: Production deployment + user feedback gathering.

---

## Pre-mortem fix (2026-08-24) — spent-check + depth guard (money-critical)

**Background:** Pre-launch pre-mortem audit identified two money/time-critical risks in the operator fee funding path. Both are now fixed and tested (packages typecheck green, 22/22 tests pass).

**FIX 1 — UTXO spent-check enforced at package boundary (money-critical):**
- **Risk:** WoC `/address/{addr}/unspent` returns already-spent outputs (field notes: confirmed-but-spent from 50 blocks ago). The app layer (`settle-actions.ts:289`) had a defense (`isOutputUnspent` filter), BUT it was not enforced at the package boundary. A caller that bypassed `getOperatorBaseUtxos` would **immediately double-spend** on first tx (`258: txn-mempool-conflict`).
- **Fix:** `selectOperatorFeeInputs` (packages/bsv/settle/operatorBaseFunding.ts:113-180) now REQUIRES a `fetchIsUnspent` callback and verifies EVERY candidate UTXO via `/tx/{txid}/{vout}/spent` BEFORE attempting BEEF fetch. Fail-closed: spent (false) or unverifiable (null) → skip. The spent-check is now a **mandatory part of the selection protocol**, not an optional app-layer defense.
- **Call sites updated:** `deliverStasToBuyer` (stas-actions.ts:409) + `finalizeStasSell` (stas-actions.ts:708) now pass `fetchIsUnspent`.
- **Evidence:** field notes verified this on mainnet in the sibling prediction-market project.

**FIX 2 — Mempool depth fail-before-broadcast (money-critical):**
- **Risk:** The system filters UTXOs by `unconfirmedAncestorCount ≤ 10` to avoid `too-long-mempool-chain` (node limit = 25 ancestors), BUT if ALL UTXOs are deep, it **falls back and returns them anyway** (settle-actions.ts:301). Build proceeds, broadcast fails, orders stuck `pending`. Already hit on mainnet (STATE.md:30-35).
- **Fix:** `selectOperatorFeeInputs` now takes optional `fetchUnconfirmedDepth` + `maxUnconfirmedDepth` (default 10). If depth check is provided and ALL available UTXOs are too deep (> maxUnconfirmedDepth), selection returns `{ ok: false, reason: "all N operator base UTXO(s) have deep unconfirmed ancestry — wait for confirmation or fund from fresh source to avoid too-long-mempool-chain" }` BEFORE building. **No silent doomed-tx assembly.**
- **Call sites updated:** both delivery + sell refund now pass `fetchUnconfirmedDepth` (via `unconfirmedAncestorCount`, now exported).
- **Evidence:** mainnet failure (STATE.md) — BUY TX-A hit `too-long-mempool-chain` because operator base descended from pre-fix stuck txs.

**Impact:** Both fixes are MANDATORY before public instant-swap. Without FIX 1, a fresh process or new integration double-spends on first tx. Without FIX 2, if operator base is funded from a deep chain, **every buy/sell fails at broadcast** → stuck orders until a fresh confirmed UTXO appears.

**Tests:** packages typecheck clean (bsv, curve, db), 22/22 package tests pass (db 1/1, bsv 2/2, curve 19/19).

## Previous fix (2026-08-04f) — covenant fee-underpayment (money-critical)

**Symptom:** every covenant-carrying tx (deploy, buy TX-A, sell TX2 refund) paid ~40 sats for a ~3,683-byte tx
(0.011 sat/byte) and was EVICTED from the mempool — nothing confirmed. **Cause:** the fee estimators sized
every output at a flat 34 bytes, ignoring the ~3,480-byte covenant OUTPUT script (and, on buy/sell, the
covenant INPUT preimage that embeds that same ~3.5KB script as scriptCode). A ~7KB covenant tx was priced as
~200 bytes.

**Fix (fee sizing + funding amounts only — no covenant/security logic touched):** every covenant tx is now
sized from its ACTUAL serialized bytes at **0.1 sat/byte** (floor `MIN_FEE=40`, which never dominates a large tx).
- `packages/curve/src/curvePool.ts` — new shared helpers `sizeCovenantTx` / `covenantFeeSats` / `varIntLen` +
  `CURVE_FEE_RATE=0.1`; size a covenant tx from the real covenant-unlock length + each real output-script length.
- `packages/curve/src/stasBuyAssembly.ts` — TX-A fee computed from the ACTUAL covenant unlock (0xc3 preimage,
  independent of the buyer input) + the ~3.5KB successor output BEFORE funding; buyer funds `cost + fee`.
- `packages/curve/src/stasSellAssembly.ts` — TX2 fee computed from the ACTUAL co-signed unlock (0xc1) + both
  pinned outputs BEFORE funding TX1; the TX1 funding output (consumed WHOLE as the fee) is sized to it.
- `packages/bsv/src/settle/operatorBaseFunding.ts` — `FEE_RATE 0.05→0.1` (TX1 split-tx outputs are genuine 34B).
- `packages/bsv/src/settle/operatorDeliver.ts` — 0.1 + sized from actual STAS output lengths + a safe STAS-input budget.
- `apps/web/scripts/lib/flat-key-wallet.mjs` — shim `createAction` sizes the fee from each real output-script
  length (so the ~3.5KB DEPLOY covenant output is counted, not flattened to 34B), 0.1 sat/byte.
- Also bumped the STAS mint-issue (`issue/genesis.ts`) and STAS-transfer/return (`settle/index.ts`) fee rates
  0.05→0.1 so every step of the round-trip clears the eviction threshold.

**Mainnet proof (post-fix run):** DEPLOY (3,683-byte covenant tx) paid **369 sats = 0.1002 sat/byte** and
persists (not evicted) — the exact tx that previously stuck at 0.0109. MINT contract 0.1025 (shim). BUY TX-A
(7,338 bytes) was correctly sized to **734 sats = 0.1000 sat/byte** but could not RELAY: the operator base
UTXO descends from a chain of PRE-FIX stuck txs (rooted at a 0.0109 old DEPLOY covenant that consumed the
confirmed 20k UTXO and will never mine), so BUY hit `too-long-mempool-chain` — an environment clog from the
OLD bug, not the fee logic. **To land a full green round-trip, the operator base needs a fresh CONFIRMED UTXO**
(the current one is bricked behind pre-fix stuck txs that cannot be double-spent under BSV first-seen). Green:
bsv/curve/web typecheck, web build, curve 19 + bsv 2 unit tests, verify-stas 33/33 (offline buy/sell use dummy fees).

## Latest change (2026-08-04e) — e2e-stas harness fully flat-key / toolbox-free (testing)

The self-driving harness (`apps/web/scripts/e2e-stas.mjs`) no longer touches `@bsv/wallet-toolbox` AT ALL.
Reason: the toolbox storage corrupts under this workload ("merged Beef failed validation" once it holds a
chain of unconfirmed txs) — it broke both the operator toolbox and BSV Desktop. New shim
`apps/web/scripts/lib/flat-key-wallet.mjs` (`FlatKeyWallet`) implements a minimal `@bsv/sdk` `WalletInterface`
from the operator flat key + WhatsOnChain: crypto (getPublicKey / createSignature / createHmac-for-createNonce /
verifyHmac / encrypt / decrypt) is inherited from `@bsv/sdk` `ProtoWallet` over a `KeyDeriver` (the SAME
BRC-42/BRC-29 derivations the toolbox did); `createAction` funds the requested outputs from the operator BASE
UTXOs (`selectOperatorFeeInputs`), signs P2PKH with the flat key (`signOperatorP2pkhInput`, SIGHASH_ALL|FORKID),
appends change back to base, builds the atomic ancestry BEEF, and broadcasts the chain parents-first
(`broadcastBeefChain`), returning `{ txid, tx: atomicBEEF }`; `listOutputs` returns the base UTXOs;
`internalizeAction`/getNetwork/getHeight/getVersion/isAuthenticated are trivial. All non-operator harness roles
(admin deploy+mint, buyer payment, seller STAS return) now run through this shim — production still uses real
user/admin wallets; the shim is TEST-ONLY and the operator key stays local to `apps/web/scripts` (never imported
into packages). No production covenant/assembly/server-action logic changed. Green: web/bsv/curve typecheck, web
build, verify-stas 33/33. **Mainnet proof:** two runs each broadcast DEPLOY→MINT→BUY→DELIVER live (8 txs total);
SELL's funding createAction also broadcast. Remaining: a full green round-trip needs a shallow mempool chain —
running the harness twice back-to-back stacked both runs' unconfirmed txs into one >25-deep chain, so SELL's STAS
return hit the node's `too-long-mempool-chain` limit (an environment limit, not a shim/covenant bug). Run ONCE
from a confirmed base (or wait for the mempool to confirm between runs) to land the full round-trip.

## Latest fix (2026-08-04d) — operator OFF wallet-toolbox → flat-key + WoC fee path (money-critical, ADR-028)

**Symptom (live):** under trade load the operator's `@bsv/wallet-toolbox` custody wallet corrupted — its
remote storage rejected EVERY `createAction` with "merged Beef failed validation" once the operator held a
chain of unconfirmed txs (a delivery per buy, a refund per sell each leave un-mined operator change). The
trade path is inherently an unconfirmed chain, so delivery/refund could not build at all. **Fix:** the
operator now funds its own tx fees from spendable sats at its BASE P2PKH address (owner pkh = hash160(operator
pubkey) — the same flat key that co-signs the covenant + owns the STAS vault), signed with raw low-S ECDSA and
broadcast via WoC with the proven multi-pass unconfirmed-chain flush. `@bsv/wallet-toolbox` is DROPPED from
the trade path (deprecated, kept only for the harness's non-operator wallet roles). New pure helper
`packages/bsv/src/settle/operatorBaseFunding.ts` (`@launchpad/bsv/settle/base-funding`):
`selectOperatorFeeInputs` / `buildOperatorFundingTx` / `signOperatorP2pkhInput`. **Delivery** (`operatorDeliverStas`)
is now ONE tx `[token, base fee input(s)] → [recipient, (token-change), BSV-change to base]` (no separate TX1),
both ancestries merged into the atomic BEEF, flushed via the new `broadcastBeefChain`. **Sell refund**
(`buildStasSellRefundTx`) keeps its two-tx shape — the covenant pins EXACTLY two outputs (ANYONECANPAY_ALL), so
TX1 is a flat-key split that mints an exact-fee output (change back to base) and TX2 consumes it WHOLE as the
fee; the covenant + all security asserts are untouched. **The operator key stays callback-only** (`signFeeDigest`/
`signCovenant`/`signTokenDigest` = `operatorSignDigest`; never imported into `packages/bsv`/`packages/curve`).
`settle-actions.ts` gained `getOperatorBaseUtxos` + `broadcastBeefChain`; `deliverStasToBuyer` + `finalizeStasSell`
no longer call `getOperatorWallet()`. Harness logs `operatorBaseBalance` start/end. Green: bsv/curve/web typecheck,
web build, verify-stas 33/33, bsv unit 2/2. **NOT yet run on mainnet — base address `1D86zXnT7hhB7cLYE8NxAd2WZeXqnEcpxF`
is being funded; the maintainer runs the harness once funds land.**

## Latest fix (2026-08-04) — unconfirmed-safe delivery BEEF + buy-side recovery (money-critical)

Live-test symptom: a buyer paid (TX-A broadcast, pool advanced to sold=2) but the operator STAS
delivery FAILED with "could not fetch vault ancestry BEEF (mint may still be confirming)" — buyer
paid, got no tokens, and it couldn't be retried. **Root cause:** `deliverStasToBuyer` fetched the
vault ancestry via `getSourceBeef` → WoC `/tx/{txid}/beef`, which only returns a BEEF for a
CONFIRMED tx (needs the merkle proof). A fresh mint — and every subsequent delivery, which moves the
vault to a NEW unconfirmed tx — is unconfirmed, so the fetch 404'd and delivery aborted, even though
the operator can spend the raw UTXO fine (the BEEF is only used to build the buyer's returned SPV
anchor, not the broadcast). **FIX 1:** new `getSourceBeefDeep(txid)` in `settle-actions.ts` builds an
unconfirmed-safe ancestry BEEF — walks the vault ancestry, `mergeRawTx`-ing each UNCONFIRMED tx and
recursing into its parents, and anchoring at CONFIRMED ancestors by merging their `/beef` (merkle
BUMP) and stopping. Bounded (visited set + 200-node budget) and fail-closed (any fetch gap /
unreachable root → null, never a partial/unanchored BEEF). Verified by round-tripping through
`Beef.fromBinary` + requiring `findAtomicTransaction(tip)` to resolve. `deliverStasToBuyer` now uses
it, so deliveries work immediately after mint and back-to-back. Offline check: `packages/curve/test/
deep-beef.test.mjs` proves an unconfirmed tip anchored by a bump-carrying ancestor yields a valid,
atomic-resolvable BEEF (node suite 19/19). **FIX 2 (buy-side recovery, mirrors the sell recovery):**
`getPendingStasDeliveries(saleId, buyerIdentity)` lists a buyer's `curve_buy` orders `pending`/
`settling` with `txid` null (paid, undelivered); `completePendingStasDelivery({orderId, buyerIdentity})`
guards ownership + not-yet-delivered and DELEGATES to the idempotent `deliverStasToBuyer`. Buy tab in
`StasTradeCard.tsx` surfaces a warning notice + "Complete delivery" button (matches the Sell-tab
"Complete refund" pattern). Closes the noted buy-side "no retry" follow-up. Green: bsv/curve/web
typecheck, web build, verify-stas 33/33, curve node suite 19/19. **Existing stuck bt2 buys are
recoverable via the new control after a dev-server restart.**

## ✅ FULL ROUND-TRIP PROVEN ON MAINNET (2026-08-04)

Option B (wallet-STAS operator-gated curve) ran end-to-end on BSV mainnet with a tiny demo pool
(supply 5, k 1, seed 546): **deploy** `f34927aa` → **mint** to vault → **buy** 2 (pool → `234b3db5:0`,
sold=2, reserve 549) → **sell** 2 back to sold=0 → **refund** `340e1f00` (spends pool `234b3db5:0` →
successor `340e1f00:0` @ 546 sats sold=0 + 3-sat refund to the seller `1J5oRN9m…`). The first live
sell hit the `poolScriptForSold` sold=0 bug (below), which was fixed + the stuck sell recovered via
the new "Complete refund" control; the sell-to-zero successor now validates on the real network.

## ✅✅ FULL SELF-DRIVING ROUND-TRIP PROVEN ON MAINNET (2026-08-04) — deploy→mint→buy→deliver→sell→refund

The complete Option-B two-way STAS bonding curve ran end-to-end on BSV mainnet, fully automated by
the operator flat key over WhatsOnChain — NO wallet-toolbox, NO BSV Desktop, NO human signing (the
`e2e-stas` harness + `FlatKeyWallet` shim play every role from the operator's base UTXOs at `1D86…`).
Run txids: mint `34e2d40b`, delivery `fe149176` (verified valid STAS: 1→buyer, 2→vault change, BSV
change→base), return `f7165b98`, refund `caf36b55`; back-to-genesis returned `authentic:true`.

This closed the whole cascade of live-test failures — each a real fix (all committed):
- **Operator OFF wallet-toolbox** (b5f96b3): the toolbox storage corrupts under trade load
  ("merged Beef failed validation" once it holds an unconfirmed chain — it broke the operator AND
  the user's BSV Desktop, repeatedly). Operator delivery/refund fees now come from flat-key base
  UTXOs via WoC (`operatorBaseFunding` + `getOperatorBaseUtxos` + `broadcastBeefChain`).
- **Covenant fee underpayment** (1d84351): fees were sized at 34 B/output, ignoring the ~3.5 KB
  covenant output → ~40 sats on a ~3.7 KB tx (0.011 sat/byte) → mempool-EVICTED. Now sized from
  ACTUAL tx bytes at 0.1 sat/byte (covenant txs pay ~370+ sats and CONFIRM).
- **Deep-chain UTXO selection** (a2b90ca + f62ecc8): `getOperatorBaseUtxos` now skips base UTXOs
  whose unconfirmed ancestry is deep (throttled/retried/fail-closed WoC walk) so a run doesn't
  build past the node's 25-ancestor mempool limit; picks the clean/confirmed base.
- **WoC indexing-lag retries** (b57c76f delivery vault resolve; 31f43a0 back-to-genesis): a step
  can fire seconds after its dependency tx broadcasts, before WoC indexes it → transient "fetch
  gap". Both now retry with backoff. Back-to-genesis stays FAIL-CLOSED (a counterfeit never starts
  passing by waiting).
- (earlier this day) unconfirmed-safe delivery BEEF `getSourceBeefDeep` (f35206d), buy-side
  "Complete delivery" recovery, getOutputScriptHex JSON fallback (14b89b6), poolScriptForSold
  sold=0 fix (b84f37a).

**Operator funding model (current): flat key + WoC only.** Sats live at the operator BASE address
`1D86zXnT7hhB7cLYE8NxAd2WZeXqnEcpxF`; delivery/refund fees + change flow through it, signed by the
flat key (callback-only, never in packages). Deprecated `operator-toolbox.ts` kept for the ops
balance script only. FEE_RATE 0.1 sat/byte sized from real bytes.

## Latest fix (2026-08-04b) — getOutputScriptHex unconfirmed-safe (back-to-genesis over mempool ancestry)

`getOutputScriptHex` used WoC `/tx/{txid}/out/{vout}/hex`, which only serves CONFIRMED txs — so the back-to-genesis provenance walk (and vault resolution) FAILED with "provenance unverifiable (fetch gap)" whenever a returned token's ancestry ran through an UNCONFIRMED operator delivery (the common case: buy then immediately sell). Added a fallback to the `/tx/{txid}` JSON endpoint (returns mempool txs + the same `scriptPubKey.hex`) so the walk works over unconfirmed ancestry. Same bytes, not a weaker check — a counterfeit still fails to reach the operator's issuance. Sell-after-buy now verifies.

## Latest fix (2026-08-04) — poolScriptForSold sold=0 bug (money-critical)

`poolScriptForSold` (the scrypt-ts-free successor byte-patch, shared by BUY and SELL) encoded the
`sold` @state bigint with the minimal ScriptNum encoder, so `sold=0` became an EMPTY push. But
scrypt-ts's own `getStateScript()` encodes `sold=0` as a single-byte `0x00` push (`01 00`) — so the
byte-patched successor for `sold=0` was 1 byte short, its 4-byte `le4` body-length field differed,
and the covenant's `hashOutputs` assert failed. Any full SELL landing on `newSold=0` was rejected at
PC 2989 ("top stack element must be truthy"). Fixed with a dedicated `stateInt()` encoder in
`packages/curve/src/curvePool.ts` (0 → `[0x00]`, all nonzero unchanged = identical to scrypt for
1..1000, incl. the 127→128 / 255→256 sign-byte transitions). `scriptNum` (used by the MINIMALDATA
unlocking-arg pushes, where 0 must stay OP_0) is untouched. Buys are unaffected (proven: buy
127→128 assembled-validates). verify-stas now **33/33** (was 17): +12 byte-match asserts for sold ∈
{0,1,2,16,127,128,129,255,256,257,999,1000}, +2 sell-to-zero (sold=2→0 VALIDATES), +2 buy 127→128.

## Current phase

**🏗️ OPTION B — wallet-held STAS curve, operator-gated (2026-07-31, ADR-028).** User chose the
hybrid over the pure-trustless ledger (ADR-027): buyers get a real STAS token in their wallet on
buy, it leaves on sell, curve moves; sells are operator-gated (the only way to have wallet tokens
+ a shared reserve). Cheaper + size-stable per trade (small reserve covenant vs the ledger that
grows with holders). **Operator = a SERVER KEY** (always-open market) — to be run as a server-side
wallet (wallet-toolbox), NEVER a raw key in the repo (golden rule 3). **Built + tested so far:**
Operator wallet DONE. Key = single server key in gitignored `apps/web/.env` (OPERATOR_KEY, 64-char
hex), TWO roles. (a) **Covenant co-sign** — `operatorSignDigest()` in `operator-wallet.ts`: raw
bsv-js ECDSA over the sighash, forced low-S, verified valid; flat key only. (b) **Custody** (sats/
STAS, sell-tx fees, broadcast) — `@bsv/wallet-toolbox` (`operator-toolbox.ts` + `getOperatorWallet()`/
`operatorBalance()`), init against `store-us-1.bsvb.tech`/main = the SAME storage `npx fund-metanet`
uses, so `fund-metanet --chain main --private-key <OPERATOR_KEY> --satoshis N` funds it directly;
verify via `pnpm --filter @launchpad/web operator:balance`. (Correction: wallet-toolbox needs NO
TAAL key — broadcaster auto-configures on init; the earlier "lean WoC to avoid TAAL" reasoning was
wrong. See ADR-028 update.) Funds land at a BRC-42-derived address in the toolbox basket (tracked
via the toolbox), NOT the key's base P2PKH addr — so `1D86…` is no longer "the" fund address. pkh
`84f96c45461ae06a21e06e56d4cb45f8e2a91323` (baked into pools). Reserve-covenant successor derives
by cheap byte-patching (`poolScriptForSold` — verified genesis→5, 5→10) since state is just `sold`
— no scrypt-ts per trade (only the deploy genesis needs it, for k/supply/operatorPkh). Buy reuses
the proven LINEAR buy path (same `buy(delta,newReserve)` sig+sighash); sell reuses the operator-
cosign pattern. RESERVE TRADE LAYER PROVEN: StasCurvePool has 2 methods, so the unlock needs a
1-byte method SELECTOR appended (buy = `00`, sell = `51`); with that, the reserve buy validates in
@bsv/sdk via the linear path (byte-patch successor + linear unlock + `00`) — confirmed. Genesis
deploy script via CLI `stas-genesis` (~3.5KB). **Operator FUNDED** (2026-07-31): 10,000 sats live in
the toolbox wallet, UTXO `ff88621b8a45f94bf502c23cc3539fe5b3a72402c5a54a796dee8410d5c0bc16.0`
(WoC 200). Funding was blocked for a while by a corrupted BSV Desktop state — 15 `unproven` dead
txs (a double-spend chain) held all confirmed coins hostage and couldn't be aborted via BRC-100
(`listActions` returns no `reference`); cleared wallet-side (Monitor/resync), then `operator:fund`
(local wallet signs `noSend` → raw tx broadcast via WoC → internalized) landed it. Scripts:
`operator:fund`, `operator:balance`, `wallet:clean` (diagnostic).
**STEP 1 (DEPLOY + MINT) app layer — ✅ DONE (2026-07-31):** two new thin-shell files mirror the
proven curve/ledger patterns. `apps/web/lib/stas-service.ts` = child-process bridge to CLI
`stas-genesis` (scrypt-ts out of Next), `stasGenesisScript(k, supply, operatorPkh)`.
`apps/web/lib/stas-actions.ts` = server actions, deploy + mint each a prepare/record split (nothing
broadcasts; client signs): `createStasPool` (bakes operator pkh into the reserve covenant, upserts
`variant='stas'` draft, returns deploy scriptHex) → `markStasPoolDeployed` (records UTXO, live);
`prepareStasMint` (plan to issue the full `supply` as STAS to the operator vault — owner =
`getOperator().pubHex`, redemption = wallet anchor) → `recordStasMint` (persists `Token.issuanceTxid`/
`stasTokenId`); `getStasPool` state reader. Params `STAS_K=1n`/`STAS_SUPPLY=1000n` (mirror ledger).
No schema change. `issueStasGenesis` (`genesis.ts`) gained a backward-compatible optional
`ownerPubHex` override so the STAS supply mints straight into the OPERATOR vault (omit → instant-buy
byte-for-byte unchanged, verified); `prepareStasMint` returns that operator pubkey for the client to
pass through, and its advertised `ownerPkh`/`tokenId` match the on-chain result. typecheck (bsv +
curve + web) + web build all green. Only the client mint/deploy UI wiring remains for Step 1. See
ADR-028 Step-1 update.
**STEP 2 (BUY assembly) — ✅ DONE (2026-07-31):** a stas buy is TWO sequenced txs.
**TX-A "reserve buy"** (buyer-signed, client-assembled): `packages/curve/src/stasBuyAssembly.ts`
`buildStasBuyTx` mirrors the proven `buildCurveBuyTx` — `[pool covenant BUY input (0xc3;
pushes delta,newReserve,preimage + a 1-byte '00' method SELECTOR since StasCurvePool has 2
methods), buyer payment input (0x41 SIGHASH_ALL)] → [reserve successor @ newReserve]` — but
carries NO token receipt (delivery is TX-B), so the single output + the buyer's SIGHASH_ALL is
the anti-shortchange gate (operator can't mis-price → covenant; can't add/divert outputs → buyer
sig). Successor by the same byte-patch `poolScriptForSold` (proven byte-equal to scrypt-ts
`getStateScript` in the offline test); validates the assembled covenant input via
`validateAssembledCovenantInput` (@bsv/sdk) before returning; broadcasts nothing.
**TX-B "STAS delivery"** (operator-signed, backend): `packages/bsv/src/settle/operatorDeliver.ts`
`operatorDeliverStas` mirrors `transferStas` but signs the vault token input with the OPERATOR
FLAT key (`operatorSignDigest`, injected as a callback so the key never enters `packages/bsv`)
and the fee input with the toolbox wallet — the custody split (STAS inventory at the operator
base P2PKH vault, fee sats in wallet-toolbox). The vault UTXO moves per delivery, so the current
vault is resolved on-chain (`resolveCurrentPool(issuanceTxid)`) + from-chain BEEF. **Server
actions** (`apps/web/lib/stas-actions.ts`): `prepareStasBuy` (latest-outpoint sequencing anchor +
`curveCost`), `recordStasBuy` (mirror `recordCurveBuy`'s optimistic outpoint guard; Order left
`pending`, `paymentTxid`=TX-A — no separate DB reservation, the serial pool UTXO IS the concurrency
model), `deliverStasToBuyer` (claims `pending→settling`, builds TX-B, broadcasts TX1→TX-B
operator-side via WoC with Missing-inputs retry, stamps `settled`+delivery `txid`). No broadcast at
import/build/typecheck — delivery fires only on explicit invocation. Green: bsv+curve+web
typecheck, web build, offline covenant tests 5/5 (added: byte-patch==scrypt-ts successor; assembled
TX-A validates). **ADVERSARIALLY VERIFIED (3 lenses, all could-not-refute):** (1) anti-shortchange —
ran the compiled covenant through @bsv/sdk: UNDERPAY (newReserve-1) and SKIM (output0 value low) both
REJECTED, honest accepted; buyer's 0x41 is the sole anti-divert gate (SINGLE only pins output0); fee
unskimmable (no TX-A change); covenant enforces `newReserve >= reserveBefore+cost` (>= not =, not
exploitable — surplus stays locked in reserve). (2) delivery — token conservation exact, operator key
confined to the callback, vault walk follows token-change to the unspent tip, atomic pending→settling
claim blocks double-delivery. (3) sequencing — line-equal to recordCurveBuy, stronger oversell guard.
**Known follow-ups (non-blocking, mostly inherited from the proven paths):** (a) delivery is
at-least-once — a node-accepts-but-broadcast-reports-failure window could double-deliver on retry;
clean fix = a per-delivery idempotency key tied to the consumed vault outpoint; (b) TX-B liveness is
the acknowledged ADR-028 operator trust (operator can stall/censor delivery, never overpay/divert);
(c) inherited: record trusts the client-supplied successor outpoint was broadcast (same as recordCurveBuy).
**STEP 3 (SELL) — ⚠️ BUILT BUT NOT DRAIN-SAFE (2026-07-31): 3 verifier findings open, do NOT ship/live-test the sell until fixed.**
(1) CRITICAL double-refund replay — `recordStasSell` has no dedup on the STAS-return txid (`Order.paymentTxid` not unique), TX2 does not consume the returned STAS UTXO, and finalize never checks the return is unspent/unclaimed → a seller returns δ STAS once and finalizes N refunds, draining the reserve. Fix: dedup on the returned outpoint (one refund per return) + verify-unspent-and-unclaimed inside the atomic finalize.
(2) CRITICAL back-to-genesis is existence-only, not amount-provenance — `verifyStasBackToGenesis` breaks on the FIRST same-tail STAS parent and never sums token amounts, so an attacker merges 1 genuine token with a fabricated same-tail counterfeit (creatable per ADR-024) into a δ-token return and passes → operator refunds δ, reserve drained. This is the exact ancestry-unverifiable asymmetry ADR-025 flagged. Fix: full-ancestry walk — EVERY same-tail STAS input must recurse to the operator's genuine issuance (reject any counterfeit sibling) + verify token-amount conservation; bounded + fail-closed.
(3) Payee not covenant-bound (operator-trust) — sell() pins the refund AMOUNT + successor but NOT the payout script; a compromised operator can redirect the refund to itself (falsifies ADR-028's "never redirect"; within the softened "compromised key is reserve-critical" note). Cheap non-recompile fix: seller contributes a SIGHASH_ALL input to TX2 so their sig commits the payee. DECISION PENDING.
Amount-cap, ordering (B2G before cosign), fail-closed, and sold-underflow guards DO hold. Original step-3 build notes below (mechanics are as described; the drain gaps are in the off-chain guards, not the covenant math):
**STEP 3 (SELL) — build detail (2026-07-31):** a stas sell is TWO sequenced txs — the
**atomic single tx is INFEASIBLE**, not just undesirable: the deployed `StasCurvePool.sell()`
is `ANYONECANPAY_ALL` and asserts `hashOutputs == hash256(poolOut ++ payoutOut)` = EXACTLY
two outputs (successor pool + seller refund), so a 3rd "STAS to vault" output (and the
holder's STAS input, which needs its own STAS continuation output) can't ride in the same
tx; the offline interpreter confirms the covenant rejects it. Recompiling the covenant was
out of scope (breaks verified Step-1/2). So: **TX1 "STAS return"** (holder-signed wallet STAS
transfer of `delta` to the operator vault pkh — client, DEFERRED UI) + **TX2 "reserve refund"**
(operator-cosigned). **TX2 assembly** = `packages/curve/src/stasSellAssembly.ts`
`buildStasSellRefundTx`, mirroring `verify-stas.ts`'s canonical `buildSell`: `[pool SELL input
(0xc1; unlock pushes delta,payoutScript,operatorPub,operatorSig,preimage + the 1-byte '51' SELL
selector), operator fee input (0x41, consumed WHOLE as the miner fee — no change output, the
covenant pins 2 outputs)] → [reserve successor @ reserveBefore−refund, seller refund P2PKH @ the
curve refund]`. Successor by the same byte-patch `poolScriptForSold` (proven byte-equal to
scrypt-ts for the sell direction). The runtime sell-unlock encoder `encodeSellUnlockingHex`
(curvePool.ts, scrypt-ts-free) is proven **byte-identical to the compiled sell ABI**; the
assembled covenant input re-validates in @bsv/sdk before broadcast. Operator co-signs
`sha256sha256(preimage)` with the flat key (`operatorSignDigest`, byte 0xc1) via an injected
`signCovenant` callback (key never enters `packages/curve`). **BACK-TO-GENESIS before cosign is
the anti-forgery rule** — there was NO existing B2G helper (ADR-024's "authentic" was a WoC
explorer read, not code), so `settle-actions.ts` gained `verifyStasBackToGenesis` (walks the
returned STAS's ancestry via WoC to the operator's OWN issuance, requiring a well-formed STAS
script + matching **token tail** fingerprint at every hop + a same-tail parent, until it lands on
`issuanceTxid`; **fail-closed** — any gap → no refund) + `findStasOutputToPkh` (locates the
seller's `delta`-token output to the vault, so a wrong amount/destination is caught). **Server
actions** (`stas-actions.ts`): `prepareStasSell` (sequencing anchor — latest outpoint + refund
preview + operator vault pkh), `recordStasSell` (creates `curve_sell` Order `pending`,
`paymentTxid`=TX1; does NOT advance the pool), `finalizeStasSell` (claims `pending→settling`;
finds the returned STAS; runs B2G; builds TX2 against the latest outpoint; broadcasts fee-funding
then TX2 with the Missing-inputs retry; advances the pool `sold−=delta`, `reserveSats=reserveAfter`,
`poolTxid→successor` under the SAME optimistic outpoint guard as `recordCurveBuy`; stamps the
Order `settled`+`refundTxid`). Operator cosign+broadcast fire ONLY inside `finalizeStasSell` —
nothing at import/build/typecheck. **INVARIANTS proven (offline 10/10, +5 sell):** covenant caps
the refund + pins the successor — operator SKIM (seller underpaid) and WRONG operator key both
REJECTED, honest accepted, encoder byte-matches the compiled ABI. sold can't underflow (guarded
at prepare/record/finalize). **Trust caveat vs. the infeasible atomic form (documented):** holder
returns STAS FIRST then operator refunds, so (a) the operator must be LIVE to broadcast the refund
(= Step-2 TX-B liveness trust) and (b) the operator supplies output 1, so the refund reaches the
seller only because finalize pays the seller's RECORDED address — the covenant caps the amount but
does not cryptographically bind the payee (no SIGHASH_ALL trick fixes this — see the FINAL block
below; a compromised operator key is reserve-critical regardless). Consistent with the ADR-028
operator model (can stall/censor; a compromised key is reserve-critical).
Green: bsv+curve+web typecheck, web build, offline covenant tests 10/10. See ADR-028 Step-3 updates.
**STEP 3 SELL — ✅ DRAIN-SAFE vs malicious USERS (FIX-1 + FIX-2); payee = accepted operator-trust (FIX-3 REVERTED) (2026-07-31):** adversarial review found three issues; the two attacker-exploitable
reserve drains are CLOSED, and the payee item was reframed as the already-accepted operator-trust.
**FIX 1 (double-refund replay) — CLOSED:** a single on-chain STAS return could spawn N `curve_sell`
orders (no dedup; TX2 doesn't consume the return). Now the RETURNED STAS OUTPOINT is unique evidence
— `Order.sellReturnOutpoint` (@unique, migration `20260731140000_order_sell_return_outpoint`) blocks
a 2nd order on the same return AT RECORD TIME (P2002), and `finalizeStasSell` re-checks the return is
still UNSPENT on-chain (`isOutputUnspent`) before refunding. **FIX 2 (existence-only B2G) — CLOSED:**
the walk broke on the FIRST same-tail ancestor and never summed amounts — exploit: 1 genuine token +
a fabricated same-tail counterfeit (mintable from a plain P2PKH, the ADR-025 asymmetry) merged into a
δ-return passed and drained δ. Replaced with a FULL-provenance walk (`packages/curve/src/provenance.ts`
`provenanceWalk`, pure + injectable → unit-tested): EVERY same-tail input must itself reach genuine
issuance, amount is conserved (no injected tokens), input outpoints are de-duped, the DAG is memoised
+ node-BOUNDED + FAIL-CLOSED. **FIX 3 (payee-bind) — REVERTED (ineffective + moot).** The attempted
seller-SIGHASH_ALL binding does NOT work: the covenant is ANYONECANPAY_ALL and requires only the
OPERATOR sig, so a compromised operator authors a fresh 2-output TX2 WITHOUT the seller input and pays
itself; the `out1==seller`/`inputs.length==2` app-level checks are bypassed by a key-holder. And it is
MOOT: a compromised operator key can already drain the ENTIRE reserve via forged sell-branch spends
(no STAS return needed), so payee-redirect is a strict subset of the already-accepted "operator key is
reserve-critical" trust. Reverted to the simple OPERATOR-FUNDED refund (`buildStasSellRefundTx`:
operator funds the fee input, co-signs the covenant, pays output-1 = the seller's recorded
`receiveAddress` at the curve refund). **Honest trust model:** the covenant CAPS the refund amount +
pins the successor and — with FIX-1/FIX-2 — the sell is drain-proof vs malicious USERS (no oversell,
counterfeit, or double-refund); it does NOT cryptographically bind the payee; a compromised operator
key can redirect/drain = the accepted operator-trust. Kept the one-line outpoint-dedup in
`provenanceWalk` as cheap defense-in-depth. **Proven:** offline covenant/logic tests **17/17**
(full-genuine PASSES · genuine+counterfeit merge REJECTED · fabricated-no-parent REJECTED · inflation
REJECTED · node-budget FAIL-CLOSED · duplicate-outpoint double-count REJECTED · operator-only refund
pays output-1 = the recorded address @ curve refund · skim REJECTED · wrong-operator-key REJECTED), DB
replay-guard test **1/1** (`packages/db/test/sell-replay-guard.test.mjs`, P2002 on dupe outpoint),
bsv+curve+web typecheck, web build. Migration applied + client regenerated. **Deferred: TX1 holder
STAS-return wallet assembly (client) + all sell UI + live mainnet test.**
**STEP 4 (UI + CLIENT WIRING) — ✅ DONE (2026-08-01):** the deferred money-touching client
assembly + the admin/buyer/seller UI + sale-page wiring are built; a real mainnet round-trip is now
possible. **New components (`apps/web/components/`):** `StasPoolManage.tsx` (owner: deploy +
mint, mirrors CurvePoolDeploy + IssueButton) and `StasTradeCard.tsx` (buyer + seller two-tab card,
mirrors LedgerTradeCard). **Buy round-trip (client-wired):** `prepareStasBuy` → `buildStasBuyTx`
(buyer funds+signs the SIGHASH_ALL payment input of TX-A) → broadcast TX1(payment)→TX-A with the
Missing-inputs retry → `recordStasBuy` (returns orderId) → `deliverStasToBuyer(orderId)` (operator
TX-B) → the delivered STAS is registered into the buyer's wallet (`receiveStasToken`, a nicety —
the STAS is on-chain regardless); the delivery txid is surfaced. **Sell round-trip (client-wired):**
`prepareStasSell` (returns the operator `vaultAddress` — NEW field) → the seller's live STAS UTXO is
resolved on-chain by `resolveCurrentPool(deliveryTxid)` (reuses the change-walk; picks a delivery
covering `delta`) → **TX1** = an ordinary client `transferStas` of `delta` to the vault (owner
derivation `{protocolID: STAS_PROTOCOL, keyID: slug, counterparty:'self', forSelf:false}` — the SAME
key the buy delivered to; change STAS back to self) → broadcast funding→TX1 → `recordStasSell(returnTxid)`
→ `finalizeStasSell(orderId)` (operator provenance-checks + refunds sats at the curve price, TX2);
the refund txid is surfaced. **Deploy+mint (admin):** `StasPoolManage` exposes **configurable small
`k` + `supply`** (default TINY demo pool supply=5, k=1 — so a full mainnet buy+sell round-trip is
cheap; `createStasPool` now takes `k`/`supply`, capped at supply≤1000, replacing the hardcoded
`STAS_SUPPLY=1000n`) → deploy (owner wallet `createAction` seeds the reserve covenant) → mint (owner
wallet CONTRACT→ISSUE genesis with the operator `ownerPubHex` override so the supply locks to the
vault). **Sale-page conditional:** renders `StasTradeCard` when `sale.type==='bonding_curve'` AND the
live pool `variant==='stas'`; ledger/linear variants keep their cards. **ProjectManage:** the
bonding-curve deploy area renders `StasPoolManage` for the stas variant (and offers it alongside
`CurvePoolDeploy` when no pool exists yet). **New server-action surface (`stas-actions.ts`):
`getSellerStasDeliveries(saleId, sellerIdentity)`** (a seller's settled `curve_buy` deliveries + net
held balance, to seed the sell card + pick a source). **Thin shell:** components orchestrate wallet +
server actions only; all tx math stays in `packages/curve` / `packages/bsv` / `stas-actions`. **No
auto-broadcast** — every broadcast is inside an explicit button handler or an operator server action.
Green: web typecheck, web build, verify-stas 17/17 (backend not regressed). See ADR-028 Step-4 update.
**ADVERSARIALLY VERIFIED (both client round-trips, could-not-refute):** BUY — buyer signs input 1 with
0x41 (never the covenant), no over/under-pay, parent broadcast before TX-A with safe retry, recorded
pool == broadcast successor, delivery to the buyer's own address, order recoverable on failure. SELL —
the derivation footgun is REFUTED: reproduced from @bsv/sdk BRC-42, `counterparty:'self'` makes `forSelf`
a no-op, so the delivery lock pkh and the sell-spend key are BYTE-IDENTICAL (the STAS card sidesteps the
ledger card's `'anyone'+forSelf` trap); TX1 returns exactly `delta` to the vault with change to the
seller; vault address consistent (single `getOperator()`); `>=delta` single-holding guard fails loudly.
**UX/robustness follow-ups (non-blocking, note for the live test):** (a) NO UI button to re-trigger a
STUCK delivery/refund — if `deliverStasToBuyer` or `finalizeStasSell` fails after the buyer paid / seller
returned STAS, recovery needs an operator re-invoke by orderId (re-clicking Buy/Sell would re-pay / can't
re-return since the source is spent); (b) sell needs ONE holding `>=delta` (no cross-UTXO aggregation);
(c) 200-sat default fee is thin; (d) buy delivery is at-least-once (step-2 note: per-delivery idempotency key).
**STUCK-REFUND RECOVERY — ✅ DONE (2026-08-04):** closes follow-up (a) for the SELL side — a
`curve_sell` order left `pending`/`settling` with the STAS returned (`sellReturnOutpoint`+`paymentTxid`
set) but no `refundTxid` (e.g. `finalizeStasSell` failed mid-flow on the old sell-to-zero bug) now has a
UI retry, so re-clicking Sell (which would try to return already-spent STAS) is no longer the only path.
**New server actions (`stas-actions.ts`):** `getPendingStasSells(saleId, sellerIdentity)` (lists the
seller's stuck sells — orderId/tokens/paymentTxid; seller-scoped via `buyerIdentity===sellerIdentity`)
and `completePendingStasSell({orderId, sellerIdentity})` (guards seller ownership + pending/settling +
STAS-returned + no-refund, then **delegates to the existing idempotent `finalizeStasSell`** — no finalize
logic duplicated; finalize's own `refundTxid`-short-circuit + `pending→settling` claim keep it safe against
double-broadcast). **UI (`StasTradeCard.tsx`):** `refresh()` queries `getPendingStasSells`; the Sell tab
renders a warning notice per stuck order ("You returned N tokens but the refund didn't complete") with a
"Complete refund" button → `completePendingStasSell` → surfaces the refund txid (WhatsOnChain link) or the
error, then refreshes. Thin shell (action delegates; component orchestrates); no auto-broadcast at import.
Green: web typecheck, web build (backend/`packages/curve` untouched).
**Deferred: the live mainnet round-trip itself** (needs the running operator wallet + a funded BSV
Desktop; the user runs it).
**Deferred: all UI.** See ADR-028 Step-2/Step-3 updates.
**Remaining = STAS integration + app wiring:** buy/sell UI + assembly (next steps); deploy (reserve
covenant + mint supply to operator vault via genesis.ts) SERVER layer done ↑; buy = reserve buy (client) + operator STAS delivery
(backend); sell = buyer STAS return (client) + operator reserve-refund cosign (backend, back-to-
genesis verify); UI; live test.
`StasCurvePool` reserve covenant (`src/contracts/stasCurvePool.ts`) — small, state = `sold`,
reserve = UTXO value; `buy()` open (ANYONECANPAY|SINGLE), `sell()` operator-gated (checkSig on
`operatorPkh`, ANYONECANPAY|ALL) with payout capped at the curve refund (operator can authorise/
refuse, never overpay/redirect). Offline tests 3/3 (`verify-stas.ts`): buy validates, sell
validates with operator sig, sell rejected with wrong key. **Remaining (multi-session):** (1)
server operator wallet (wallet-toolbox custody + raw co-sign) — ✅ DONE (above); (2) STAS inventory: mint full supply
at deploy (`genesis.ts`) into a vault; (3) buy assembly `[reserve buy + buyer payment + STAS vault
release(operator sig)] → [reserve successor, STAS to buyer]`; (4) sell assembly `[reserve sell
(operator cosign) + buyer STAS return] → [reserve successor, refund to seller, STAS to vault]`,
back-to-genesis verify before cosign; (5) DB (StasCurvePool state + inventory); (6) UI (tokens are
now wallet STAS); (7) live test. Reserve-covenant successor derivation can byte-patch like the
LINEAR pool (state is just `sold` — no HashedMap replay needed). The ADR-027 ledger pool stays as
the pure-trustless variant. ↓ prior phases below



**✅ BONDING-CURVE AMM · PHASE 2 (BUY + SELL) — PROVEN ON MAINNET (2026-07-31, ADR-027).**
Full trustless two-way curve works live: buys credit + sells debit an in-covenant
`HashedMap` ledger; reserve drain-proof, no forgeable token, no platform key. On-chain
round-trips: buy `ca6692f6` / `0954a7c2`, sell `62ab6894` (−1) / `6cea3e69` (−5) —
`sold` and `reserve` tracked correctly, holder-signed debits verified by the covenant.
Two deep bugs fixed during live testing: (1) spend-after-first-op needs the state
service to REPLAY the ordered op history via DIRECT in-place mutation (scrypt-ts
HashedMap is history-dependent; clone-then-new embeds the prior ledger inline = wrong
script) — verified byte-equal to real successors 04f87f04/ca6692f6; (2) holder key must
use the p2pkhInput-proven derivation (counterparty 'anyone' + forSelf) so getPublicKey
== createSignature. Also: curve orders excluded from claimable-STAS (ledger tokens
aren't wallet STAS until graduation). **NOTE:** curve "tokens" are ledger entries, NOT
wallet-held STAS — that conversion is Phase 3 (graduation).

**🏗️ PHASE 3 GRADUATION — reserve-release built + tested (2026-07-31, ADR-027).** LedgerPool
gains `payoutPkh` (immutable) + a terminal `graduate()` method: once `sold == supply`, spend
the pool to release the whole reserve to the committed payout P2PKH (no re-lock, no sig).
Full flow built: service `computeGraduate` + CLI, server actions `prepareLedgerGraduate`/
`recordLedgerGraduate`, client `buildLedgerGraduateTx`, and a "Graduate — release reserve"
control in the trade card when sold out. `payoutPkh` derived from the project payout address,
stored on CurvePool (+ migration). 16/16 ledger tests (incl. graduate accepts-when-sold-out /
rejects-early) + web build green. **Remaining for Phase 3:** (1) mint real STAS to holders from
the final ledger (reuse `genesis.ts` + `batchTransferStas`) — the actual token delivery; (2) a
cheap live test needs a small-supply pool (supply is hardcoded 1000 = ~500k sats to sell out —
make supply configurable at deploy to test graduation on mainnet cheaply). Detail ↓

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
scrypt-ts→getUnlockingScript) and re-verifies in @bsv/sdk `Spend`. **CODE-COMPLETE END-TO-END — web builds green; only the live mainnet test remains.**
Client integration done: `packages/curve/src/ledgerTx.ts` (buy/sell tx assembly from the
server unlock + wallet input, no change output so the pool's hashOutputs holds),
`apps/web/components/LedgerTradeCard.tsx` (buy credits + sell debits the ledger; holder
signs the sell digest with a derived key via `createSignature`), deploy card gains a
linear/ledger variant toggle, sale page renders LedgerTradeCard when `variant='ledger'`.
**Before running the app you MUST build the service:** `pnpm --filter @launchpad/curve
build:service` (server actions spawn `service/dist/service/cli.js`; dist is gitignored).
**Live test = deploy a ledger pool (manage) → buy → sell (dust) on mainnet.** Everything
below (covenant/service/server) is proven; this is the last step. ↓

**SERVER-SIDE INTEGRATION DONE — web builds green.** Next drives the scrypt-ts state service
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
