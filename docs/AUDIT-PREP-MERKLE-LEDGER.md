# Covenant audit prep — trustless Merkle-ledger bonding curve (ADR-030)

For an external auditor. **No non-trivial reserve should go live before this audit passes.**
This is a *separate* audit from `COVENANT-AUDIT-PREP.md` (Option B / ADR-028-029): a different
contract with a different trust model, so the drain vectors do not overlap. Audit whichever one is
actually being deployed; do not assume findings transfer.

## The one-line trust model

**Fully trustless. There is no operator key anywhere in this contract.** Buy is keyless (nobody
signs — the covenant prices it), sell is authorised by the holder's own signature, and graduation
is permissionless to a destination fixed at deploy. Consequently there is **no key-compromise
drain vector to audit** — which makes this a narrower audit than Option B, and concentrates all
risk in covenant logic. A bug in the script is the whole attack surface.

## In scope (money-critical)

| File | Role |
|---|---|
| `packages/curve/src/contracts/merkleLedgerPool.ts` | **The deployed covenant** (scrypt-ts source): `buy()` ANYONECANPAY_SINGLE keyless · `sell()` ANYONECANPAY_ALL holder-signed · `graduate()` ANYONECANPAY_SINGLE unsigned/terminal · helpers `leaf()`, `merkleRoot()`, `pathIndex()`, `emptyLeaf()`. Artifact: `artifacts/merkleLedgerPool.json`. |
| `packages/curve/src/merkleLedger.ts` | The off-chain tree that MUST agree with the in-script fold: `leafHash`, `rootFromProof`, `EMPTY_ROOTS`, `MerkleLedger`, `replayMerkleSlots`. |
| `packages/curve/service/merkleLedgerState.ts` | Successor-script + unlock construction; `normalizeOps`/`toSlotOps` (slot assignment policy). |
| `packages/curve/src/covenant.ts` | `validateAssembledCovenantInput` — the pre-broadcast interpreter guard. |

**View-integrity (not fund-critical, but audit for correctness):**
`src/merkleLedgerReconstruct.ts` (unlock parser), `service/resolveMerkleLedgerPool.ts` (chain
walk), `service/merkleLedgerClient.ts` (open client). A bug here yields a wrong *view* or an
unbroadcastable tx — it cannot move funds, because the covenant is the authority.

## Money-critical invariants to verify

1. **`sold == Σ(slot balances)`, always.** THE reserve invariant. Every buy adds `delta` to both
   `sold` and exactly one slot; every sell subtracts `amount` from both. Verify no path updates one
   without the other, and that no path writes two slots.
2. **Solvency is exact.** `reserve == seed + k·sold·(sold+1)/2` after any sequence. Note two facts
   an auditor should confirm rather than take on trust:
   - **The `/2` never truncates.** `d·(2s+d+1)` is always even (d even → product even; d odd →
     `2s+d+1` even). So there is no rounding in either party's favour, anywhere.
   - **Buy and sell are exact inverses** — `buyCost(s,d) == sellRefund(s+d,d)`. The pool therefore
     carries **no spread**: precisely solvent, never over-collateralised. See "Accepted design
     properties" below, because this has product consequences.
3. **Merkle fold equivalence.** `MerkleLedgerPool.merkleRoot()` (Script) must compute the same root
   as `rootFromProof()` (TypeScript) for every index and depth — same sibling ORDER
   (`path[h] ? sha256(sib‖node) : sha256(node‖sib)`), same DEPTH, same hash. A disagreement means
   forged balances validate. **The sharpest edge in this contract.**
4. **Append discipline.** `isNew` requires BOTH `idx == holderCount` AND an inclusion proof that the
   slot currently holds `emptyLeaf()`; `holderCount` then increments by exactly 1. Verify a new
   holder cannot land on an occupied slot (which would overwrite a balance and break invariant 1).
5. **Update discipline.** `isNew == false` requires `idx < holderCount` AND a proof of the slot's
   CURRENT `leaf(owner, oldBal)`. Because the leaf commits to the owner, a slot cannot be reset,
   and one holder cannot write over another's slot. Verify there is no path that skips this proof.
6. **Leaf encoding is unambiguous.** `sha256(ownerPkh(20) ‖ balance(8, LE))` — both fixed-width, so
   no two distinct `(pkh, balance)` pairs can serialise identically. Verify the script's
   `Utils.toLEUnsigned(balance, 8n)` matches the off-chain `writeBigUInt64LE`, including at 0 and at
   the 8-byte ceiling.
7. **Empty is distinguishable from occupied.** `emptyLeaf()` is 32 zero bytes; every real leaf is a
   sha256 image. An occupied slot can never prove empty (that would need a sha256 preimage of
   `0^32`), and an empty slot can never prove a balance.
8. **Path/index consistency.** `pathIndex(path)` and `merkleRoot(…, path, …)` consume the SAME
   array, so they cannot disagree about which slot is addressed. Verify the bit order (index bit
   `h` ↔ `path[h]`, least-significant first) matches the off-chain encoder.
9. **hashOutputs pinning, per method.** `buy` (SINGLE) pins **output 0 only** — the successor;
   further outputs are intentionally free so the payer can take change. `sell` (ALL) pins
   **exactly two** outputs (successor + payout). `graduate` (SINGLE) pins **output 0 only** (the
   payout), change allowed. Verify none can be satisfied by any other output set.
10. **Sighash discipline.** buy `0xc3`, sell `0xc1`, graduate `0xc3` (all ANYONECANPAY|…|FORKID);
    the caller's funding input `0x41`. Never `0x81` (no-FORKID) on BSV.
11. **Graduation is terminal and unsteerable.** Requires `sold == supply`; pays
    `Utils.buildPublicKeyHashOutput(payoutPkh, reserve)` where `payoutPkh` is an immutable `@prop`
    fixed at deploy; the pool does NOT re-lock. Verify a hostile graduator can only pay the project.
12. **Successor byte-exactness.** The state service must emit scripts byte-equal to scrypt-ts
    `getStateScript()`. **Known trap, hit twice in this codebase:** building an instance via the
    CONSTRUCTOR with the desired state serialises differently from mutating a prior instance, and
    the mismatch surfaces only as a `hashOutputs` failure. `merkleLedgerState.instance()` constructs
    at genesis then mutates; verify every path does.

## Reserve-drain vectors (rank + attack)

1. **Merkle fold / proof-verification bug** — wrong sibling order, an off-by-one in DEPTH, or a
   path-bit mismatch lets an attacker prove a balance they do not hold, then sell it. This is the
   highest-value target and the reason the contract exists; attack it hardest.
2. **Append onto an occupied slot** — would overwrite a live balance and break `sold == Σ slots`,
   leaving the reserve short. Guarded by invariant 4; try to defeat both halves independently.
3. **Cross-owner slot write** — crediting/debiting a slot whose owner differs. Guarded by the owner
   being inside the leaf commitment (invariant 5).
4. **Stale-proof replay** — reusing a proof from an earlier root. Should fail because the root
   moved; confirm there is no path that accepts a proof against a root other than `this.root`.
5. **Reserve underflow on sell** — `reserveAfter = utxo.value − refund`. Confirm `refund` can never
   exceed the reserve given invariant 2 (it should be impossible, but confirm rather than assume).
6. **OP_PUSH_TX / preimage malleability** — the standard covenant concern: verify the preimage is
   validated (`checkPreimage` via `@method`) and that `ctx.utxo.value` cannot be spoofed.
7. **`holderCount` manipulation** — incrementing without an append, or an append without an
   increment.

*Not applicable here (unlike Option B): there is no operator key, so no key-compromise drain, and
no off-chain provenance gate to defeat.*

## Accepted design properties (call these out, don't "fix" them silently)

- **No spread.** Buy and sell are exact inverses, so the pool is precisely solvent and never
  over-collateralised, and **nothing but miner fees discourages wash trading**. If a fee is wanted,
  it is a covenant change and a re-audit.
- **Duplicate slots are permitted.** A client may append a second slot for a holder who already has
  one. Harmless to the reserve (the sum is conserved) but a UI must AGGREGATE per holder. The
  reconstruction replays recorded slot indices for exactly this reason.
- **Hard ceiling of 65,536 holders** (DEPTH 16). Past that, new holders cannot join — but existing
  holders keep trading and graduation still works, so it degrades gracefully. Confirm the ceiling is
  acceptable for the intended launch sizes.
- **Dust is client policy, not covenant policy.** The client refuses refunds under 546 sats; the
  covenant does not. A 294-sat payout was accepted by a real node during testing, so do not rely on
  the dust floor as a protocol guarantee.
- **Throughput is unchanged by this ADR.** One hot UTXO ⇒ ~25 trades per confirmation window per
  pool (`TRUSTLESS-LEDGER-ROADMAP.md` Limit B). That is liveness, not safety, and contention
  recovery makes losers land eventually — it does not raise the ceiling.

## Existing evidence to review

- **Unit, 41/41** (`pnpm --filter @launchpad/curve test`) — including `merkle-ledger.test.mjs` (tree
  + proof correctness, forged-balance rejection, stale-proof rejection) and `merkle-solvency.test.mjs`
  (exact division, no-spread, telescoping, a 40-seed buy/sell fuzz asserting the invariants after
  EVERY operation, and a full-exit test showing the reserve returns to exactly the seed).
- **Adversarial Script attacks, 34/34** (`service/verify-merkle-adversarial.ts`) — builds a VALID
  unlock and then surgically rewrites its bytes, so the covenant (not our builder) is what rejects.
  Covers tampered/zeroed/swapped/short-length siblings, flipped path bits, claiming another
  holder's slot, `isNew` flipped in both directions, inflated and deflated `oldBal`/`delta`/
  `newReserve`, redirected and inflated payouts, an added third output on a sell, swapped sell
  outputs, a substituted pubkey, and three graduation-redirection attacks. Honest baselines are
  asserted in the same run so the suite cannot pass by rejecting everything.
- **Offline interpreter, 24/24** (`service/verify-merkle-pool.ts`) — every spend validated through
  the @bsv/sdk interpreter over the exact assembled bytes, plus underpay / forged-signature /
  oversell / early-graduation rejections and parser round-trips.
- **Mainnet lifecycle, 6/6** (`service/verify-merkle-mainnet.ts`) — pool
  `4c6faf9753fc1228f270453429da2974d2dde0b854b90f8b873bbdb5fd4b7837:0` (k=1, supply=80):
  deploy → append `676a7baf…` → append `41056d43…` → **slot update** `0ad2a6af…` → holder-signed
  sell `5caf3de5…` → buy-out `44f2b5dc…` → graduate `9c5c114d…`. Script measured **11,864 B at every
  step** regardless of holder count.
- **Chain reconstruction, 16/16** (`service/verify-merkle-resolve.ts`) — the pool above rebuilt from
  chain alone, recovering a holder whose key no longer exists locally.
- Decisions: `docs/DECISIONS.md` **ADR-030** (and ADR-026/027 for lineage);
  roadmap `docs/TRUSTLESS-LEDGER-ROADMAP.md`.

## Known gaps in our own testing (please cover these)

- **The Script has been ATTACKED but not FUZZED.** `verify-merkle-adversarial.ts` runs 34
  hand-designed byte-level attacks against the unlocking script (see evidence above), which is a
  materially stronger claim than we could make before — but 34 chosen cases are not random or
  mutational fuzzing. Untried: randomised sibling/path corruption at scale, malformed pushdata
  framing, out-of-range path values, oversized/undersized argument encodings, and non-minimal
  scriptNum encodings of `oldBal`/`delta`/`newReserve`. **Please fuzz it properly.**
- **No formal argument that the off-chain and in-script folds are equivalent.** They agree on every
  case we test; equivalence has not been proven.
- **Multi-slot holders are untested on mainnet.** Permitted by design, exercised off-chain, never
  driven live.
- **DEPTH is fixed at 16 and untested at the boundary** — slots near 65,535, and the exhaustion
  behaviour itself, are reasoned about but not exercised.
- **8-byte balance ceiling** (`writeBigUInt64LE`) versus a `supply` that could in principle exceed
  it — the client would throw, but the covenant's own behaviour at that boundary is untested.

## Deliverable requested

A finding-by-finding report on invariants 1-12 and drain vectors 1-7, explicit coverage of the five
gaps above, a go/no-go with a stated maximum reserve size, and a re-audit trigger list (any change
to the contract, the tree encoding, DEPTH, the state service's successor derivation, or the sighash
flags).
