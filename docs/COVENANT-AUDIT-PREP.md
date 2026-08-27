# Covenant audit prep — Option B STAS bonding curve (ADR-028/029)

For an external auditor. **No non-trivial reserve should go live before this audit passes**
(ADR-026/027). This scopes exactly what to audit, the money-critical invariants, the
reserve-drain vectors, and the existing evidence — so an auditor starts fast.

## The one-line trust model
Trustless **pricing** (the covenant caps amounts — nobody can be over/under-paid or
diverted), **operator-gated** authenticity + sequencing on sell. A **compromised operator
co-sign key is reserve-critical** (ADR-029) — audited separately as key custody
(`docs/OPERATOR-KEY-CUSTODY.md`); this doc is about the covenant + assembly.

## In scope (money-critical — a bug here = a drainable reserve)

| File | Role |
|---|---|
| `packages/curve/src/contracts/stasCurvePool.ts` | **The deployed covenant** (scrypt-ts source): `buy()` (ANYONECANPAY_SINGLE, keyless), `sell()` (ANYONECANPAY_ALL, operator checkSig). Compiled artifact: `packages/curve/artifacts/stasCurvePool.json`. |
| `packages/curve/src/curvePool.ts` | Runtime successor derivation (`poolScriptForSold`, `stateInt`), unlock encoders (`encodeBuyUnlockingHex`, `encodeSellUnlockingHex`), fee sizing (`sizeCovenantTx`/`covenantFeeSats`), curve cost. Scrypt-ts-free — MUST byte-match the compiled contract. |
| `packages/curve/src/covenant.ts` | `validateAssembledCovenantInput` — the pre-broadcast @bsv/sdk `Spend` guard. |
| `packages/curve/src/provenance.ts` | `provenanceWalk` — off-chain back-to-genesis authenticity (the anti-forged-STAS gate before the operator co-signs a sell). |
| `packages/bsv/src/settle/stasBuyAssembly.ts` · `stasSellAssembly.ts` | Buy TX-A / sell TX2 assembly + fee sizing. |
| `packages/bsv/src/settle/operatorDeliver.ts` · `operatorBaseFunding.ts` | Operator STAS delivery (TX-B) + flat-key base fee funding + spent/depth guards. |
| `apps/web/lib/stas-actions.ts` · `settle-actions.ts` | Server orchestration (sequencing outpoint guard, sell replay guard, broadcast). |

## Money-critical invariants to verify

1. **Curve pricing rounds against the taker.** Buy: `newReserve ≥ reserveBefore + k·δ·(2·sold+δ+1)/2`; sell refund `= k·δ·(2·(sold−δ)+δ+1)/2` capped by the covenant. The `/2` is exact (never truncates in the taker's favour). Confirm no rounding path lets a buyer underpay or a seller overdraw.
2. **hashOutputs pinning.** `buy()` (SINGLE) pins **output-at-its-input-index** = the reserve successor; other outputs are intentionally free (the STAS delivery rides via the buyer's SIGHASH_ALL). `sell()` (ALL) pins **exactly two outputs** (successor + payout). Verify the covenant cannot be satisfied by any other output set.
3. **Successor script byte-exactness.** `poolScriptForSold` must byte-equal scrypt-ts `getStateScript()` for every reachable `sold` — the **`stateInt(0)` → 1-byte `0x00`** case and every OP_NUM2BIN/ScriptNum width boundary (127→128, 255→256, …). A 1-byte drift breaks `hashOutputs` (this bug shipped once and was caught — see `verify-stas` sold=0 tests). This is the sharpest edge.
4. **Sighash discipline.** Buy covenant `0xc3` (ANYONECANPAY|SINGLE|FORKID); buyer payment `0x41` (ALL|FORKID — the anti-shortchange gate); sell covenant `0xc1` (ANYONECANPAY|ALL|FORKID); STAS token input `0x41`/`0xc1` per stas-js; never `0x81` (no-FORKID) on BSV.
5. **Operator gate on sell.** `sell()` asserts `hash160(operatorPub) == operatorPkh` + `checkSig(operatorSig, operatorPub)`. Confirm the payout amount + successor are covenant-pinned so the operator can only authorise/refuse — never overpay or redirect beyond the curve.
6. **Back-to-genesis is full-ancestry + conservation + fail-closed.** `provenanceWalk`: EVERY same-tail STAS input must recurse to the operator's own issuance; token amount conserved (no injected tokens); input outpoints de-duped; DAG memoised + node-bounded; any gap → reject. Verify a genuine+counterfeit merge and an inflated return are both rejected.
7. **Sell double-refund replay guard.** `Order.sellReturnOutpoint` is `@unique` (one refund per on-chain return) AND `finalizeStasSell` re-checks the return is still unspent before refunding.
8. **Atomicity limits (design, not bug).** A real STAS token cannot ride the covenant-spend tx (classic-STAS single-change rule) → buy is TX-A + TX-B, sell is TX1 + TX2. Confirm the honest gaps: delivery/refund are operator-**liveness**-soft (never misdistribution-soft), mitigated by the idempotent recovery + auto-sweep.

## Reserve-drain vectors (rank + attack)
- **Covenant math / serialization bug** (preimage parse, state rewrite, **OP_NUM2BIN width**) → a permanently drainable reserve. The demonstrated sharp edge is state-int width (the sold=0 fix).
- **Compromised operator co-sign key** → forged sell-branch spends drain the whole reserve with no seller involvement. Mitigation: HSM/KMS (`OPERATOR-KEY-CUSTODY.md`) + signer policy. Payee-binding was proven ineffective (ADR-029) and is moot vs a key-holder.
- **Forged wallet-token sell-back** → inert against the ledger model; against Option B it is blocked **off-chain** by the fail-closed `provenanceWalk` before co-sign — an advisory guard, **not in-script enforcement** — audit its completeness + fail-closed behaviour hard.

## Existing evidence to review
- Offline: `verify-stas` **33/33** (covenant buy/sell, byte-match, skim/wrong-key reject, sold=0, B2G), `verify-atomic-buy` **4/4** (covenant tolerates layouts; atomic infeasible is a STAS rule, not covenant), provenance unit tests, DB replay-guard test.
- Mainnet: full deploy→mint→buy→deliver→sell→refund round-trips (txids in `docs/STATE.md`), both headless (`e2e:app`) and a manual UI pass.
- Decisions: `docs/DECISIONS.md` ADR-024..029; strategy `docs/research/decentralized-funding-strategy.md`.

## Out of scope for THIS audit
- The app/DB orchestration layer is not reserve-critical (the on-chain covenant is the authority); review it for correctness, not for fund safety.
- The deferred trustless variants (`ledgerPool.ts` = ADR-027 HashedMap ledger, `linearCurvePool.ts` = ADR-026) are NOT part of the launch and are hidden in the UI — audit only if/when they ship (the HashedMap/SMT is a separate, larger audit surface).

## Deliverable requested from the audit
A written finding-by-finding report on invariants 1–8 and the three drain vectors, with a
go/no-go for a stated maximum reserve size, and a re-audit trigger list (any covenant/encoder/
sighash/fee-sizing change).
