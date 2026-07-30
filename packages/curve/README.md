# @launchpad/curve — bonding-curve AMM covenant (Phase 0 spike)

The trustless bonding-curve AMM (ADR-026). This package is being built in phases;
**Phase 0 (toolchain spike) is complete and green.**

## What Phase 0 proved

The AMM needs a **stateful OP_PUSH_TX covenant** — a single UTXO that constrains
its own spending transaction to re-lock with correctly-updated state. Phase 0
validates that we can actually build and run one in our stack, using a trivial
`Counter` covenant (state = an integer that may only increment by exactly 1) —
all the covenant machinery, none of the curve math.

Result, verified offline in `@bsv/sdk`'s own Script interpreter (`pnpm --filter
@launchpad/curve test`):

- a `count 0 → 1` spend is **accepted**;
- a spend that leaves the count unchanged, or skips to `2`, is **rejected**;
- the chain continues: `1 → 2` is accepted.

So: scrypt-ts compiles a stateful covenant to Bitcoin Script, the compiled
`Tx.checkPreimage` (OP_PUSH_TX "optimal" forged-signature construction) +
`hash256(hashOutputs)` self-replication constraint both execute, and they do so
in the exact runtime we ship. The only remaining Phase-0 step is a live mainnet
broadcast (needs a funding wallet).

## Layout

- `src/contracts/counter.ts` — the sCrypt covenant **source** (build-time only).
- `artifacts/counter.json`, `artifacts/counter.scrypt` — the **compiled** contract
  (ABI + locking-script hex, and the readable sCrypt). Committed.
- `artifacts/locks.json` — instance locking-script hexes for count 0/1/2, a test
  fixture emitted by the compile.
- `src/covenant.ts` — **runtime** (`@bsv/sdk` only): assembles a covenant spend
  (pushes the BIP-143 preimage as the unlocking script) and validates it. This is
  the pattern the AMM buy/sell flow will use.
- `test/counter.covenant.test.mjs` — the offline interpreter proof.

## Compiling the covenant

sCrypt is a **build-time dependency only**; the app never imports scrypt-ts at
runtime (it uses the committed hex + `@bsv/sdk`). Recompile after editing a
contract:

```bash
pnpm --filter @launchpad/curve compile
```

### Why compilation runs in isolation

`scrypt-ts-transpiler` is a `ts-patch` program transform pinned to TypeScript
**~5.3**. Inside this pnpm workspace, peer-dep hoisting resolves scrypt-cli's
`typescript` to 5.9.x, and the transform then **silently no-ops** (compiles with
no error but emits no artifact). `scripts/compile.sh` sidesteps this by compiling
in a throwaway npm project with TS 5.3.3 pinned, then copying the hex back. If
you ever see "Project compilation completed! 0 passing" with an empty
`artifacts/`, that TS-version mismatch is the cause.

## Next (not yet built)

Phase 1 — buy-only linear-curve covenant (`paid ≥ k·Δ·(2s+Δ+1)/2`, verify-invariant,
round against the taker), covenant-native token, operator-sequenced. See ADR-026.
