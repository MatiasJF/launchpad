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

### Limit A — transaction SIZE (ledger-specific, SOLVABLE)
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
3. **Open client library** — package buy/sell construction (compiled ledger-state + `ledgerTx`)
   into a standalone lib taking `(wallet, genesisTxid)`, resolving state from chain — no server
   actions, no DB. This is the "anyone builds a UI" boundary. (scrypt-ts must compile with
   `tsc`, not esbuild/tsx — a known constraint; ship the compiled service in the lib.)
4. **Permissionless sequencing** — sell is already holder-signed; the client self-assembles
   against the resolved tip and retries on outpoint-move ("loser re-signs", no operator
   sequencer).
5. **Remove the operator from the critical path** — permissionless graduation (anyone triggers
   the mint once sold out); decentralize overlay hosting for discovery.
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

**Next (phase 3 — the open client):** package buy/sell construction + `resolveLedgerPool` into a
standalone library taking `(wallet, genesisTxid)` with no server actions and no DB — the "anyone
builds a UI" boundary. The mainnet harness already builds every covenant spend without the app or
Prisma (`verify-reconstruct-mainnet.ts` does deploy/buy/sell against a flat key), so phase 3 is
largely extracting that into a published surface + a wallet adapter. Note the scrypt-ts constraint:
ship the **compiled** service (tsc, not esbuild/tsx).

Related: `docs/research/decentralized-funding-strategy.md` (the trust-model analysis + open
questions), `docs/DECISIONS.md` ADR-026 (keyless buy) / ADR-027 (ledger) / ADR-029 (why Option B
shipped first), `docs/COVENANT-AUDIT-PREP.md`.
