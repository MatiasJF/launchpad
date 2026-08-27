# Trustless bonding-curve protocol — roadmap (ledger track)

**Goal:** a bonding-curve **protocol** anyone can build a UI over — one that "just stands"
if the page is down or the operator disappears. This is the trustless upgrade beyond the
shipped Option B (ADR-028/029, operator-gated). Chosen track: the in-covenant **ledger**
(ADR-027). Scaling constraints are baked into step 1 on purpose (see §3) — they change the
design, not just the tuning.

## 1. What "a protocol anyone builds a UI over" means (the acceptance test)
Three properties, none of which Option B has:
1. **On-chain is the source of truth** — pool state is discoverable on-chain (or an open
   overlay), never from the operator's DB.
2. **An open client constructs the spends** — covenant-aware tx construction is an open
   library anyone runs, not the operator's private app.
3. **No party can steal, censor, or lock funds** — the covenant enforces custody/price/refund;
   the hot UTXO has a permissionless self-assembly fallback.
If those hold, an operator (if any) is a pure convenience (faster indexer/sequencer) that can
stall but never steal.

## 2. What's already built (so this is mostly the protocol layer, not covenant work)
ADR-027 ledger is **trustless on-chain already**: buy is keyless, sell is holder-signed +
inclusion-proof, drain-proof (13/13 tests), graduation built (16/16). The operator's only
current roles are (a) **sequencing** the hot UTXO and (b) the **DB mirrors** the ledger. The
job is to remove those two dependencies.

## 3. The two scaling limits (decide these at step 1)

### Limit A — transaction SIZE — ✅ SOLVED (ADR-030, mainnet-proven)
Superseded by **ADR-030**: the ledger is now a 32-byte Merkle root over fixed-depth (16) holder
slots, with a 512-byte inclusion proof per spend. Measured on mainnet: the locking script is
**11,864 B regardless of holder count** (`service/verify-merkle-mainnet.ts`, 6/6, pool
`4c6faf97…:0`) against 10,884 + 64·holders for the HashedMap. Contract
`src/contracts/merkleLedgerPool.ts`, tree `src/merkleLedger.ts`, state service
`service/merkleLedgerState.ts`. Break-even ~18 holders; unbounded advantage above that.
The original analysis, kept for context:

#### (original) Limit A — transaction SIZE (ledger-specific, SOLVABLE)
A `HashedMap` that embeds every holder makes the covenant output **O(holders)** — huge,
expensive txs as the pool grows (the reason Option B exists). **Mandate: a fixed-depth Sparse
Merkle Tree, not the HashedMap.** State holds only the **root (32 B)**; each unlock carries an
**O(depth) inclusion proof** (~1 KB for a 32-deep tree). Tx size then **bounded, constant in
holder count**. STATE flags the fork: *"HashedMap (else a hand-rolled fixed-depth SMT)."* The
SMT is the production ledger; the HashedMap is a prototype.

### Limit B — SERIALIZATION (fundamental to a curve, NOT fully solvable)
The pool is **one hot UTXO** → trades chain → BSV rejects the ~26th unconfirmed descendant
(`too-long-mempool-chain`). So **~25 trades per confirmation window (~10 min) per pool** — a
*burst* ceiling, not just concurrency. And a curve is **un-shardable** (price = f(sold) is
cumulative; K sub-pools = K cheaper sub-curves an arbitrageur drains).

Burst-throughput levers for one pool, with honest trust cost:

| Lever | Throughput | Trust cost |
|---|---|---|
| **Project isolation** (one pool/project) | fine for many projects × few each | none; doesn't help a single viral pool |
| **Batch settlement** (curveCost is additive: N buys of ΣΔ price identically to one buy of ΣΔ → collapse a burst into one covenant hop) | high | a **sequencer** — semi-trust: can censor/order, never steal (covenant caps the aggregate); a keyless buy loses the per-buyer anti-shortchange gate → needs a Merkle-root-of-orders consent mechanism (**open R&D**) |
| **Different pricing model** (fixed-price inventory / Dutch or batch auction) | high, **shardable** | none — but not a bonding curve |

**Headline:** size is solvable (SMT); single-pool curve burst is capped (~25/window) unless you
add a sequencer or drop the cumulative-price model. **Trustlessness and unbounded single-pool
burst are in tension for a curve — pick per launch (§7).**

## 4. Step-1 design mandates
1. **Fixed-depth SMT ledger** (bounded tx size) — not HashedMap.
2. **Per-pool throughput target chosen up front** — decides whether a curve is even the right
   primitive for a given launch (§7).
3. **Batch settlement designed now, built later** — so it slots in when a pool needs it, no
   redesign. Specify the sequencer contract + the Merkle-root-of-orders consent question.

## 5. Build phases
1. **Reconstruct the ledger from chain (the linchpin) — ✅ BUILT + OFFLINE-PROVEN (17/17).** The
   ordered-history **`replay()`** in `packages/curve/service/ledgerState.ts` already rebuilds the
   *exact* on-chain `LedgerPool` instance from an op list (proven byte-exact against real mainnet
   successors `04f87f04:0`, `ca6692f6:0`). The missing piece — deriving that op list **from chain
   instead of the DB** — is now built: `packages/curve/src/ledgerReconstruct.ts` parses each hop's
   input-0 unlocking script into its op `(ownerPkh, delta)` (buy selector `OP_0`, delta at chunk 3;
   sell selector `OP_1`, amount at chunk 4, `delta = −amount`; graduate `OP_2` is terminal), and
   `reconstructLedgerHistory(genesisTxid, fetchSpendOf)` walks the successor chain feeding those ops
   to `replay`. **`packages/curve/service/verify-reconstruct.ts` proves it offline (17/17):** build a
   real buy/sell op sequence → collect the on-chain unlocks → reconstruct from the scripts alone →
   the rebuilt lockingScript **byte-matches the successor tip**, both via direct parse and a
   genesis→tip chain-walk. The DB is now provably **non-authoritative**. Remaining: back `fetchSpendOf`
   with a real WhatsOnChain spent-lookup + tx-fetch (that is phase 2). (This reconstructs the *current
   HashedMap* ledger — enough for the trustless demo; the SMT migration in §3 is a separate covenant
   change layered on after.)
2. **On-chain pool discovery — ✅ BUILT + MAINNET-PROVEN (10/10).**
   `packages/curve/service/resolveLedgerPool.ts` — `resolveLedgerPool(genesisTxid, {k, supply,
   payoutPkh})` returns the live outpoint, reserve, `sold`, every holder balance and the full op
   history **from WhatsOnChain alone, no DB**. The walk is **self-verifying**: each hop recomputes
   the expected successor from the ops parsed so far and matches an output byte-for-byte, so a
   misparse fails at its own hop rather than surfacing as a confusing end-state mismatch, the
   successor needs no prefix heuristic, and graduation is detected naturally.
   **Proven on a live mainnet pool** (`verify-reconstruct-mainnet.ts`): deployed genesis
   `3e247404…:0` (k=1, supply=100, payoutPkh `121c7ea8…`), put a real 3-op multi-holder history on
   chain — A +40 (`fb7197f7…`), B +20 (`0bbe4c40…`), A −30 holder-signed (`888f3724…`) — then
   rebuilt it with `--resolve <genesisTxid>` and nothing else: reserve 1011, sold 30, A=10, B=20,
   and the reconstructed lockingScript **byte-matched the on-chain tip**. Holder B's pkh
   (`275532e2…`) was recovered **from chain alone** — its key was a throwaway that no longer exists
   locally, which is the claim in its strongest form.
   **WoC quirk handled (cost a failed run):** `/tx/{txid}/{vout}/spent` returns the same 404 for a
   genuinely-unspent output and for one whose spend is in the mempool but not yet indexed, so a read
   moments after a trade reports a **stale tip and a short history**. `resolveLedgerPool` re-checks
   an apparent tip (`tipRechecks`, default 2) before concluding.
3. **Open client library — ✅ BUILT + MAINNET-PROVEN (19/20 → 20/20 after a test-constant fix).**
   `packages/curve/service/ledgerClient.ts` — `LedgerPoolClient(genesisTxid, {k, supply, payoutPkh})`
   with `state()` · `quoteBuy/quoteSell/quoteSellFee` · `balanceOf` · `buildBuy` · `buildSell` ·
   `buildGraduate` · `broadcast`, plus `LedgerPoolClient.genesisScript(terms)` to OPEN a pool.
   Depends on nothing of ours: no server actions, no Prisma, no operator, no stored state.
   **Wallet-agnostic** — it never sees a key: callers pass a funding input + an @bsv/sdk
   `UnlockingScriptTemplate` (what `new P2PKH().unlock(priv)` returns, and what a BRC-100 adapter
   can implement) and, for sells, a `Holder` that signs one 32-byte digest. Every build re-resolves
   state from chain and interpreter-checks the assembled bytes, so a client cannot broadcast a
   spend the covenant would reject or build against a tip it read earlier.
   **Acceptance test** `verify-open-client-mainnet.ts` — a full mainnet round trip using ONLY the
   client: OPEN (genesis `84e72674…:0`) → READ (sold 0) → BUY 40 keyless (`c6e1b0dc…`) → RE-READ
   from a *second* client built from scratch → SELL 25 holder-signed with **no operator co-signature
   in the path** (`2e8cf89a…`) → a *third* fresh client rebuilds the pool and **byte-matches the
   on-chain tip** → 4 guard assertions (refuses overspend / beyond-supply / underfunded / dust
   refund). `--resolve <genesisTxid> [supply]` reads any existing pool.
   *(scrypt-ts constraint holds: ship the **compiled** service — tsc, not esbuild/tsx.)*
   **Protocol constraint surfaced:** a sell's fee input is consumed WHOLE (0xc1 pins exactly two
   outputs, so no change is possible) — sellers must pre-size an exact fee UTXO, which
   `quoteSellFee()` returns and the harness demonstrates as a two-tx flow.
4. **Permissionless sequencing — ✅ BUILT + MAINNET-PROVEN under REAL contention (14/14).**
   `LedgerPoolClient.submitBuy` / `submitSell` wrap the build in a bounded contention loop: on an
   outpoint-move rejection the client re-resolves the tip, rebuilds, **re-signs**, and retries. No
   operator sequencer exists in the path — ordering is decided by the network.
   `isOutpointConflict()` distinguishes a race (`txn-mempool-conflict`, `Missing inputs`,
   `txn-already-known`) from a genuinely invalid spend, which is surfaced immediately rather than
   retried, so the loop cannot mask real bugs.
   **Proven with actual conflicting broadcasts on mainnet** (`verify-sequencing-mainnet.ts`, pool
   `31820de7…:0`): two holders built buys against the SAME tip; A landed (`d1902f08…`) and B's
   pre-built tx was **rejected by the node with `258: txn-mempool-conflict`**, then recovered in 2
   attempts (`d3bdfb7f…`). A sell race followed — B moved the tip under A's sell, and A rebuilt,
   **re-signed** and landed (`3fa3af76…`); the test asserts one fresh signature per attempt, which
   is the "loser re-signs" property directly. Final: 4 ops replayed, none lost, reconstruction
   byte-matched the tip.
   **Honest consequence (documented in the API):** a rebuilt trade is **re-priced at the new curve
   position**. Observed live: B's buy went 210 → 1010 sats (A's win moved `sold` up), and A's sell
   refund went 605 → 715 (B's buy moved it up again — a loser can be repriced either way). The
   covenant will not honour a stale quote, so a UI should re-quote and confirm rather than blindly
   retry; `submit()` returns `attempts` and `repriced` for exactly that.
5. **Remove the operator from the critical path.**
   **5a. Permissionless graduation — ✅ PROVEN END-TO-END ON MAINNET (15/15).** The last covenant
   path that had never run on a live pool. Pool `75f84209…:0` (k=1, supply=24) was bought out to
   exactly `sold == supply` (A +14, B +10), then graduated by a **STRANGER** — a freshly generated
   key holding no tokens, no operator role and no relationship to the pool (`82e5dd53…`). Verified
   on chain: the full **846-sat reserve went to the payout committed at deploy**, output 0 is the
   payout (pinned by the covenant), **no value leaked to any third destination**, and the graduator
   was **net −1,727 sats** — it *paid* to graduate and extracted nothing. Guards proven too: cannot
   graduate before sell-out, cannot buy past a sold-out curve, cannot graduate twice.
   **The final ledger survives the pool UTXO** — after graduation `resolveLedgerPool` still returns
   `graduated: true` plus every holder balance, which is exactly the list real STAS is minted
   against; losing it would strand every contributor.
   `buildGraduate` now lets the graduator take **change** (ANYONECANPAY|SINGLE pins only output 0),
   so triggering a graduation costs a stranger a fee rather than their whole UTXO — otherwise a
   permissionless action carries a needless disincentive.
   `resolveLedgerPool` no longer calls *any* unparseable spend a graduation: it confirms the spend
   actually pays the committed payout the full reserve, so a parser gap can't masquerade as "the
   sale completed".
   **5b. Decentralised discovery — ✅ THE TERMS ARE NOW ON-CHAIN.** Reading a pool needs its genesis
   outpoint AND its immutable terms (k, supply, payoutPkh). The outpoint was on-chain; the terms
   lived only in our database, so a client holding the txid still had to ask US — a real dependency
   that quietly undercut "anyone can build a UI over it". The deploy transaction now carries a
   **44-byte OP_RETURN** announcing the terms (`src/poolAnnounce.ts`,
   `OP_FALSE OP_RETURN 'BSVLP' 'mlp1' <k> <supply> <payoutPkh> [<ticker>]`), and
   `resolveMerklePoolFromGenesis(genesisTxid)` reads a pool from the txid ALONE.
   **The announcement is unsigned and therefore untrusted** — anyone can write one claiming any
   terms. It is safe because the terms are CHECKABLE: they are used to rebuild the genesis locking
   script, which must byte-match the covenant output at that outpoint. The script commits to k,
   supply and payoutPkh, so a lie cannot survive. Verified against the live mainnet pool
   `38d331f7…`: true terms byte-match, while a swapped payout, an understated supply and an inflated
   k are each rejected. 9 parser tests (54/54 total).
   **Still open:** ENUMERATION — finding pools you were never told about needs an indexer or overlay,
   because nothing lets you scan the chain for a prefix unaided. The format is public and
   self-contained so anyone can run that index, which is the difference between a convenience and a
   dependency, but we have not built one.
6. **Prove it** — a mainnet round-trip **buy → sell → graduate**, driven by the open client,
   **chain-only (no operator, no DB)**, reconstructing the ledger from chain each step. This is
   the demo that settles the trustless claim.

## 6. Honest hard parts / R&D
- **Ledger reconstruction**: ✅ **DONE + offline-proven** (`ledgerReconstruct.ts`, 17/17). The
  byte-exact `replay()` was already mainnet-proven; the unlock-script parser is now built and shown
  to extract `(ownerPkh, delta)` from real buy/sell hops with the rebuilt script byte-matching the
  successor. The only remaining reconstruction risk is operational: the real chain-walk fetcher must
  handle WoC quirks (reorgs at the tip, spent-lookup lag) — phase 2.
- **SMT covenant is the largest audit surface** — external audit before any real reserve (see `COVENANT-AUDIT-PREP.md`).
- **scrypt-ts ledger-state client-side** in the open lib (compiled, not bundled).
- **Batch-settlement consent** without an interactive round (the keyless-buy anti-shortchange gap).
- **Overlay hosting bootstrap** (independent discovery hosts) and **permissionless graduation**.
- **Wallet-portability tradeoff stands**: ledger tokens become wallet STAS only at graduation — the price of a trustless sell.

## 7. The per-launch decision (curve vs. shardable model)
- **Niche / isolated** (year-1 target: 20-30 projects × few contributors): the ~25/window
  single-UTXO curve is fully trustless and sufficient — no batcher.
- **Viral single pool expected**: either accept a **semi-trusted batcher** on the curve, or use
  a **shardable trustless model** (fixed-price / auction via the assurance contract) for that
  launch. A pure-trustless single curve pool cannot exceed ~25/window — physics, not a bug.

## 8. Progress + next concrete step
**✅ Done (branch `trustless-ledger-reconstruct`):** `reconstructLedger` is built and offline-proven.
`packages/curve/src/ledgerReconstruct.ts` (`parseLedgerOp` / `reconstructHistoryFromUnlocks` /
`reconstructLedgerHistory`) + `packages/curve/service/verify-reconstruct.ts` (17/17): the ledger
reconstructs from on-chain unlock scripts alone and byte-matches the successor tip, via both direct
parse and a genesis→tip chain-walk with an injected `fetchSpendOf`.

**✅ Phase 2 done — `resolveLedgerPool` is built and MAINNET-proven (10/10, see §5.2).** Pool state
(outpoint, reserve, `sold`, all holder balances, full history) now resolves from WhatsOnChain alone.
**Protocol property 1 of 3 — "on-chain is the source of truth" — is met for the ledger pool.**

**Reference pool (keep — the July pool's params were lost with a DB reset, making it
unverifiable):** genesis `3e2474045088c9eb8ba484a723294d4c92a09d4348f67a88241d4c824d6d9a2c:0`,
k=1, supply=100, payoutPkh `121c7ea8310c…` (client). Re-verify any time with:
`node packages/curve/service/dist/service/verify-reconstruct-mainnet.js --resolve <genesisTxid>`.

**✅ Phases 2, 3 and 4 done — all MAINNET-proven (see §5.2 / §5.3 / §5.4).**
**All three protocol properties from §1 are now met for the ledger pool:** on-chain is the source
of truth (`resolveLedgerPool`), an open client constructs the spends (`LedgerPoolClient`), and no
party can steal, censor or lock funds — buy is keyless, sell is holder-signed, graduation is
permissionless to a destination fixed at deploy, and **sequencing the single hot UTXO needs no
operator** (proven under real contention). The remaining operator role is zero on the trade path.

Every covenant path — buy, sell, graduate — has now run end to end on mainnet, and the full
lifecycle is closed.

**The graduation mint remains the one unenforced step**, and there are now two responses to it,
recorded in `docs/DECISIONS.md`:
- **ADR-031 (done)** — the settlement record makes unminted debt public per project, shown before a
  buyer commits. Disclosure, not enforcement.
- **ADR-032 (PROPOSED)** — a delivery bond: graduation splits the reserve, and holders can claim
  their share of the bond after a deadline if the project has not delivered. Economic enforcement.
  Blocked on one honest question — a delivered holder could still claim (double-dipping), and
  preventing that would need the covenant to verify a STAS mint, which is impossible because
  **STAS ownership is P2PKH and a covenant can never custody STAS.** Still open: **decentralised discovery** (a client must be told a genesis
txid — the last operator touchpoint, §5b), the **SMT migration** for Limit A (tx size is
O(holders) today: these pool txs are already ~22 KB), and Limit B — **~25 trades per confirmation
window per pool**, which contention recovery does not change: the loop makes losers land
eventually, it does not raise throughput.

**Reference pools (keep — the July pool became unverifiable when a DB reset lost its terms):**
| pool | terms | state | note |
|---|---|---|---|
| `3e2474045088c9eb8ba484a723294d4c92a09d4348f67a88241d4c824d6d9a2c:0` | k=1, supply=100 | sold 30, reserve 1011, 2 holders | phase-2 proof (§5.2) |
| `84e72674c5fdf6dc2a62f51255b6c3a157e16370be9d2130ab9b10307e4da6af:0` | k=1, supply=60 | sold 15, reserve 666 | phase-3 open-client proof (§5.3) |
| `cd55e7538ba0c393…:0` | k=1, supply=60 | sold 40, reserve 1366 | abandoned mid-run (fee-estimate bug); left as-is — recovering 1.3k sats would cost ~3.4k in fees |
| `31820de7626df95349ea5ffab5cb20421fa398f5a81a5d8b4bd7df577dec265b:0` | k=1, supply=200 | sold 59, reserve 2316, 2 holders | phase-4 contention proof (§5.4); history `+40 +20 +10 -11`, two of them raced |
| `75f842099dda03afc45087dda18a43cc7cb86d51f40a2ef64fb5cfd92b566c96:0` | k=1, supply=24 | **GRADUATED** (`82e5dd53…`) | phase-5a proof; terminal — reserve released to the committed payout, ledger A=14 B=10 still reconstructible |
| `7d87322dce2c619a…:0` | k=1, supply=24 | GRADUATED (`2ac4e0c8…`) | first graduation run; 12/13 — the one failure was a bad test assertion (compared the graduator's own change to the reserve), not a defect |
| `a0ae17e2df16ba57…:0`, `1828ba336c8145ea…:0` | k=1, supply=200 | partial | earlier phase-4 attempts abandoned on a dust-floor guard; the guard was correct, the test's hardcoded sell amount was not |

Re-verify any of them: `node packages/curve/service/dist/service/verify-open-client-mainnet.js --resolve <genesisTxid> <supply>`.
Total mainnet spend across phases 2–5a plus the ADR-030 covenant: **~113k sats** from the test
wallet (156,820 → ~44k). The wallet was consolidated once mid-run
(`service/consolidate-test-wallet.ts`) — the harnesses fund a run from a SINGLE input, so a
fragmented wallet fails with "no verified-unspent UTXO > N" while holding plenty.

**Next (phase 5 — remove the last operator touchpoints):** exercise **permissionless graduation**
end-to-end on mainnet (the covenant path is built and unit-tested, but no live pool has been driven
to `sold == supply` and graduated by a non-owner), and decentralise **discovery** — today a client
must be told a genesis txid, which is the last place an operator is load-bearing. After that, the
open engineering items are the **SMT migration** (Limit A) and the batch-settlement R&D (Limit B).

Related: `docs/research/decentralized-funding-strategy.md` (the trust-model analysis + open
questions), `docs/DECISIONS.md` ADR-026 (keyless buy) / ADR-027 (ledger) / ADR-029 (why Option B
shipped first), `docs/COVENANT-AUDIT-PREP.md`.
