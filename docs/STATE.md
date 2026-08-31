# Project State

_Last updated: 2026-08-31 — by: the escrow presale is proven on mainnet; ADR-033/034/035 fixed what the runs exposed_

## The delivery fee buys latency, not safety (2026-08-31, ADR-036)

Chasing an apparent 4.7x overpayment on the shipped STAS path, the measurement inverted the premise.
Probed at 7,000 bytes — the size a batch delivery really is — **0.15 and 0.10 were mined into the block
they were broadcast, while 0.05, 0.025, 0.01, 0.005 and 0.001 were all still unconfirmed eight blocks
later.** Production agreed: of three real deliveries at 0.05, only `170cc017` was mined; `da8b0d47` and
`bc05f10b` sat in the mempool 18 blocks on.

**Then block 964709 swept the whole low-fee backlog and mined every probe, down to 0.001 sat/B (7 sats).**
Both "stuck" deliveries landed in it too. So there is **no observable fee floor at 7 KB** — there is a
latency gradient: 0.15 and 0.10 were mined in ~1 block, everything at or below 0.05 in ~10 blocks
(≈1.5–2 hours).

`batch.ts` still goes **0.05 → 0.1**, but for the corrected reason: it **buys confirmation latency**. The
next delivery chains onto this one's token change and `getSourceBeef` needs a merkle proof, so a project
settling several batches serially would otherwise wait hours between them — the reason the presale harness
needed a `--deliver` resume mode at all. 350 extra sats to turn ~2 hours into ~10 minutes is worth it; it
is not a correctness fix and must not be described as one.

**Twice in one task an early window gave a confident wrong answer** — a 2-block `--check`, then an 8-block
one. ADR-031 said a mineable rate is proven only for the size probed; this adds **the moment probed, and
only after the backlog behind it has cleared**.

**Open, and not small:** `markOrdersSettled` marks orders settled at *broadcast*, so the two stuck
deliveries are recorded as delivered. If a node evicts them the database asserts a delivery that never
happened, and the ADR-031 settlement record reads from that database.

## Next: the crowdfunding path is PROVEN on mainnet (2026-08-31)

**The escrow presale (ADR-025) ran end to end on mainnet for the first time** — a month after it was
written. `pnpm --filter @launchpad/web e2e:presale` drives the real server actions, the real DB and the
real chain: configure → mint → two pledges → **a contributor withdraws** → a replacement pledge takes
the freed slot → assemble → verify the bytes a miner saw → deliver STAS. Ten steps, all green.

**Measured, not computed** (`docs/mainnet-runs/presale-2026-08-31T09-59-00-987Z.jsonl`):

| tx | size | result |
|---|---|---|
| assurance `83689bdd…` | 486 B | 3 inputs → **one** output of 2,000 sats to the payout address · 40 sats · **0.0823 sat/B** |
| withdraw `12f26446…` | 191 B | **970 sats reclaimed** by the contributor, no operator involvement |
| delivery `170cc017…` | 6,426 B | two STAS outputs of **10 tokens each** |

The spent-checks are the proof that matters: pledges A and C were consumed by the assurance tx
(`vin 0`, `vin 1`), while the withdrawn pledge B was consumed by **its own withdrawal** — correctly
excluded from assembly.

**What the run was worth: it exposed two false claims before a real contributor ever hit them.**

1. **A pledge signature is a STANDING authorisation.** `ANYONECANPAY|ALL` binds the contributor's input
   and the fixed output — not the other contributors, and not a deadline. One 1,000-sat pledge plus an
   unrelated 2,100-sat input paying 3,000 to the project *verifies*. "Your sats cannot move unless the
   soft cap is met" was wrong; the real guarantee is that they can only ever go to **the project's
   payout address**. Destination, not threshold.
2. **The withdrawal we instructed contributors to perform was impossible.** The pledge UTXO was created
   with no basket → `basketId: undefined, change: false` → not enumerable by `listOutputs`, never
   selected, and unsignable as a caller-supplied input. `ContributeCard` said *"To withdraw, just spend
   that coin"*, which no contributor could do.

Since spending the coin is the **only** way to revoke a standing authorisation, the one control that
made the design safe was the one that did not work. **ADR-033** fixes it: a dedicated
`launchpad-pledge` basket (never `default`, which the wallet spends as change), a real `withdrawPledge`
+ Withdraw button, and `reconcileWithdrawnPledges` so a reclaimed pledge frees its slot instead of
deadlocking the presale.

**Five more defects closed in the same pass**, each found by adversarial review and each verified:
`recordPledge` was unauthenticated and could not tell a *nonexistent* outpoint from an unspent one (WoC
404s for both), so phantom pledges could brick a presale for the cost of HTTP requests — it now
validates on-chain and **verifies the 0xC1 signature**; `Pledge` gains `@@unique([txid, vout])`;
`markAssemblyBroadcast` is idempotent (a replay made 4 orders for 2 pledges); `updateSaleEscrow` freezes
terms once anyone has pledged and rejects a pledge unit that is not a multiple of the price; the fee
overhead constant goes 40 → 44 B.

**The deadline is now a server rule (ADR-034).** It had been enforced only in `saleState` (the UI) and on
instant buys — `recordPledge` checked `status === 'live'` and nothing more, and assembly had no timing gate
at all, so a raise that closed months ago was still assemblable by anyone holding the rows. Pledges are now
accepted only within `[startsAt, endsAt)`; assembly stays open for a 24h settlement grace (filling to the
last moment then settling is the *normal* shape of an assurance contract); past that, pledges `expire` —
and expired pledges stay **withdrawable**, since a failed raise is when the reclaim matters most.

The card no longer claims what ADR-033 disproved. It reads "non-custodial — your sats stay in your own
wallet", then the real distinction: a pledge fixes **where** the sats can go, not **when** — the signature
stands until you withdraw, and the deadline is enforced by this app, **not by the blockchain**. Chain-enforced
expiry needs `nLockTime` from the pushed preimage, which is the A2 accumulator's job (Phase 2).

**Confirmed by miners, not just mempools.** The first run's transactions are in blocks: withdrawal `12f26446…`
in **964689**, assurance `83689bdd…` and delivery `170cc017…` in **964690**.

**Multi-party aggregation is proven (2026-08-31).** Earlier runs pledged twice from one wallet, which
never tests the thing an assurance contract exists to do. The harness now runs the operator key as a
genuinely separate second contributor: two pledges signed by **two distinct pubkeys** composed into one
assurance tx (`1c95e51d…`, 488 B, 3 inputs → one 2,000-sat output), and delivery `da8b0d47…` paid
**10 tokens to each of the two different contributor addresses** (`121c7ea8…`, `84f96c45…`) with 20 as
change. The harness now fails if the assembled set spans fewer than two keys.

That run also caught a fail-closed bug in a shared helper: `getOutputInfo` retried its script lookup but
not its value lookup, so one rate-limited WoC reply returned `null` — which every caller reads as "that
output does not exist" — and delivery refused to build against a healthy vault. Fixed; see LESSONS.md.

**The wallet test came back, and it failed in the more interesting direction (ADR-035).** Tested against
real BSV Desktop: **no `launchpad-pledge` basket is shown** (the funding tx appears in history under its
description, but custom baskets are not surfaced), and the withdrawal — which the app reported as done —
paid its 970 sats to a **STAS-protocol key used as a payment address**, where they sit unspent and
invisible. The owner's diagnosis was exactly right: *"wallet dont do magic … it needs to internalise it,
if not it is to my wallets name but i dont know about it."*

This was the same defect ADR-033 fixed on the way IN, left unfixed on the way OUT. `withdrawPledge` now
derives its own BRC-29 self-payment destination (no caller-supplied address — that was the footgun),
returns an atomic BEEF, and `internalizePledgeRefund` calls `internalizeAction` so the wallet actually
adopts the coin. The card reports "in your balance" and "on-chain but not adopted" as different outcomes.

**The basket is inert, and ADR-033's pledge-visibility fix did nothing** (corrected in ADR-035 after the
owner reported a second time that no such basket exists). `createAction` does honour the tag
(`createAction.js:327`), but the two benefits claimed for it are not real: change is only ever drawn from
the `default` basket (`:53`, `:661`) and explicit outputs are `change: false` regardless (`:135`), so it
protects nothing that was at risk; and nothing in the codebase reads `PLEDGE_BASKET` back — the only
reference was a harness diagnostic against a shim whose `listOutputs` ignores its arguments, so it printed
a meaningless count that read as a pass. The pledge appears in the wallet because the wallet **built that
transaction**. The tag is kept as a free, correct label, but no claim rests on it. **The app, not the
wallet, is where a contributor sees their pledges.**

**Retested in BSV Desktop and it holds.** Pledge `47bd0a33…` reclaimed by `20b11ff8…`, 970 sats to
`14xJ3cUu…` (a fresh BRC-29 payment key, not the STAS key that stranded the first attempt), and the owner
sees **both the pledge and the withdrawal** in the wallet. The withdrawal is the one that counts: the
wallet never built it, so its presence is `internalizeAction` adopting the coin — the pre-fix attempt left
no wallet record at all.

**Both phases of ADR-025 are now proven (2026-08-31).** The presale's second phase — instant buy above
the soft cap — was built in July and never exercised. The harness now covers it from both sides: an
instant buy during the pledge phase is **refused** by `reserveOrder` (not merely hidden by the UI), and
once pledges are assembled the sale switches over and a real buy goes through — 5 tokens for 500 sats
paid on-chain, verified server-side by `verifyPaymentToAddress` against a cost the client never supplies.
A buy beyond the allocation is still refused (*"only 5 tokens left in this sale"*).

The two order kinds settle **together**: delivery `bc05f10b…` paid 10 tokens (pledge A → client), 10
(pledge C → operator) and 5 (top-up → operator) in one transaction, with 15 of the 40 minted as change.
Twelve steps green.

**Stranded-output recovery shipped.** `@launchpad/bsv/recover` (`recoverDerivedOutput` +
`internalizeRecovered`) sweeps a coin the wallet can derive but never adopted — the pre-ADR-035 refunds.
Driven from `/admin/recover`, since only the owner's wallet can sign. `signP2pkhInput` gained an optional
`derivationOverride` so an output locked to a non-BRC-29 derivation can be spent at all.

**Open:** the harness **cannot** verify internalisation (`FlatKeyWallet.internalizeAction` is a no-op
stub), so that step needs a real wallet each time — it prints that limit rather than implying a pass.

## The external audit is OUT, and ADR-032 waits on it (2026-08-28)

**`docs/research/BSVA-Covenant-Review-Brief.docx`** — 8 pages, BSVA-branded, three diagrams. It asks
one question (can anyone take satoshis they are not owed, or lock satoshis so nobody can), scopes out
the app / code style / database so no reviewer hours go where nothing can move money, and hands over
8 invariants and 7 ranked drain vectors with mainnet txids to check the bytes against. It states our
untested gaps plainly (no fuzzing, no formal argument for the fold equivalence, depth boundary and
8-byte balance ceiling unexercised) and the one accepted weakness. Regenerates in two commands from
`docs/research/covenant-brief-assets/`.

**ADR-032 does NOT block it.** The ADR claimed the bond "must land BEFORE an external audit"; that was
wrong and is corrected in place. `graduate()` is 4 lines of 209, and every drain vector lives in the
buy/sell/Merkle machinery the bond does not touch. So the audit runs against the covenant as it stands,
and the reviewer's view on whether the bond is worth building becomes an input to ADR-032 — the right
question to spend an outside expert on, since the double-dip problem has no airtight fix of ours.

**Fee calibration confirmed on chain.** The Option B round-trip transactions that were pending are now
at 105 confirmations, all in block 964189 — the covenant refund at **76 sats / 0.0101 sat/B**. The new
rate is proven by a miner, not merely accepted by a mempool. PR #4.

## The unenforced step — disclosure done, enforcement specced (2026-08-27)

The graduation mint is the one thing the covenant cannot enforce. Two responses:

**ADR-031 — settlement record. DONE.** Per project, how many tokens are still owed to holders from
graduated pools and for how long, shown BEFORE the buy control because it is useless to someone who
has already committed. The debt is snapshotted at graduation (the covenant is spent by then, so
`sold` is immutable), which means it reads from the DB with no chain walk while the chain stays the
authority. Verified against both live graduated pools: each reports "settled", and hiding their
deliveries correctly flips the record to "OWES $trust: 0/60". This is disclosure, not enforcement,
and says so.

**ADR-032 — delivery bond. PROPOSED, NOT ACCEPTED.** Graduation would split the reserve, locking a
bond that holders can claim pro-rata (proving `(pkh, balance)` against the final root — machinery
ADR-030 already has) if the project has not delivered by a deadline; the project reclaims whatever
is left after a later one. Deliver and nobody claims; fail and holders drain it — so **the holder's
decision to claim IS the signal**, and no proof-of-mint is needed.

**The constraint that forced this shape, now recorded as a hard STAS property:** a STAS locking
script is `76a914 <pkh> 88ac 69 …` — a literal P2PKH `OP_CHECKSIG`. Spending needs an ECDSA
signature from a specific key, and a covenant spends by preimage inspection, not by holding keys, so
**a covenant can never custody STAS.** That rules out the obvious "covenant releases pre-minted
tokens against a Merkle proof" design outright. It belongs beside ADR-029's single-change rule.

**Blocked on one honest question:** a holder who WAS delivered could still claim the bond
(double-dipping), and preventing it would require verifying a STAS mint in Script — which the above
forbids. Mitigations are bounded, not airtight. The alternative — accept disclosure-only and spend
the effort on the external audit instead — has deliberately NOT been ruled out.

## Discovery (2026-08-27) — the terms are on-chain, so the database is no longer needed at all

The last place we were load-bearing. Reading a pool needs its genesis outpoint AND its immutable
terms; the outpoint was on-chain but the terms lived only in our database, so a client with the
txid still had to ask us, and a holder whose project vanished could not reconstruct what they were
owed.

- **`packages/curve/src/poolAnnounce.ts`** — a **44-byte** OP_RETURN carrying the terms:
  `OP_FALSE OP_RETURN 'BSVLP' 'mlp1' <k> <supply> <payoutPkh> [<ticker>]`. Provably unspendable, so
  it costs only its bytes. Emitted as output 1 of the deploy (the covenant MUST stay output 0).
- **`resolveMerklePoolFromGenesis(genesisTxid)`** reads a pool from the txid ALONE — no terms, no DB.
- **It is unsigned, and that is fine.** Anyone can write an announcement claiming any terms. It is
  safe because the terms are CHECKABLE: they rebuild the genesis locking script, which must
  byte-match the covenant output at that outpoint. The script commits to k, supply and payoutPkh,
  so a lie cannot survive. **Verified against the live mainnet pool `38d331f7…`** — true terms
  byte-match; a payout swapped to an attacker, an understated supply and an inflated k are each
  rejected. A hint the chain itself refuses to let you lie about.
- Pools deployed before this carry no announcement and get a clear error telling the caller to
  supply terms, rather than a crash.
- **Still open: ENUMERATION.** Finding pools you were never told about needs an indexer or overlay —
  nothing lets you scan the chain for a prefix unaided. The format is public and self-contained so
  anyone can run one, which is the difference between a convenience and a dependency, but we have
  not built it.

## Trustless curve — COMPLETE END-TO-END ON MAINNET (2026-08-27)

Two full lifecycles driven through the real UI by the project owner, on mainnet, with no operator
anywhere in the trade path.

**Pool 2 (`trustless` / $tr2, genesis `38d331f7…`)** is the one that matters, because it ran on the
UNIFIED holder key:
`deploy → buy 40 (077f56f3) → sell 20 (ebd44176) → buy 40 to sell out (fd71afc5) → graduate
(7f0d9147) → mint (1b8d8fc4) → deliver (9041c8c9)`.

**The sell signed correctly under `counterparty: 'self'`** — the single risk in unifying the holder
identity, since the covenant's `checkSig` needs `getPublicKey` and `createSignature` to agree. It
had never been driven on mainnet with that derivation. It works, so the unification is proven rather
than assumed. And the delivery landed on the right key:
`ledger pkh 525f9831… == delivery 9041c8c9 vout 0` — one address is now the ledger identity, the
STAS address, and what the wallet displays.

**Pool 1 (`trust`, genesis `4cdd07f3…`)** ran before the fix and exposed the bug: its tokens sit at
the LEGACY holder key (`19b51082:0`, still unspent). `MerkleClaimTokens` derives both keys and
offers "Move to wallet & register" for legacy holdings.

**A second bug this surfaced:** registering a delivery marks the Order registered, which hides it
from the claim list. Pool 1's registration "succeeded" while sending the tokens somewhere the wallet
does not surface — so the claim that would let the holder sweep them was hidden too. The stale event
was cleared and the claim is available again. The sweep path now moves BEFORE registering, so the
mark only happens once the tokens are in the right place.

## Graduation mint (2026-08-27) — closing the dead end the manual pass found

The manual UI pass ended with a holder owning 60 tokens and **nothing to collect** — ADR-027/030
always specified minting real STAS to holders from the final ledger after graduation, but that step
had never been built. It is now.

- **`getMerkleFinalLedger(saleId)`** recomputes the mint list from the **genesis transaction alone**
  — who is owed what, plus what has already been delivered. Callable by ANYONE, so a holder can
  verify their own claim without asking the project. Verified against the live graduated pool
  `4cdd07f3…`: `5cf5d8a5… = 60`, from chain, with no database ledger.
- **`prepareMerkleMint` / `recordMerkleMint` / `recordMerkleDelivery`** — owner-gated, and delivery
  is idempotent per holder (a `curve_graduation_mint` Order is the guard), so re-running the
  distribution loop cannot double-mint to someone already paid.
- **`MerkleGraduationMint.tsx`** — owner mints the STAS genesis to their OWN key (no operator vault
  on this track) and then delivers to each holder's P2PKH address, which is the same pkh their
  ledger balance was keyed to.

**The honest part.** This is the ONE step the covenant cannot enforce, and the UI says so in a
warning panel rather than implying the chain has it covered. Atomic mint-at-graduation is
impossible for the same reason the atomic buy was — a STAS token input may carry only token outputs
plus one change output (ADR-029). What survives is **accountability, not enforcement**: the debt is
permanent, public, and recomputable from chain forever, so a project that takes the reserve and
never mints cannot hide it. That is weaker than everything preceding it and is documented as such.

## ADR-030 UI (2026-08-27) — the trustless curve is visible and usable

- **`MerklePoolManage.tsx`** (owner) — ONE signed step, and then the owner is done forever: no
  inventory to mint, no operator key to keep online. States plainly that the payout address is fixed
  at deploy and cannot be changed afterwards, including by the owner.
- **`MerkleTradeCard.tsx`** (buyer/holder) — buy (keyless), sell (holder-signed), and a graduate
  action that is offered to ANYONE once the curve sells out, because the covenant permits it.
  Quotes are computed exactly as the covenant computes them, so the price shown is the price paid.
  Warns below the 546-sat dust floor before the action can fail, and translates a lost sequencing
  race into "someone else traded first, so the price moved" rather than a raw node error.
- **Reused `buildLedgerBuyTx`/`SellTx`/`GraduateTx`** — those builders turned out to be
  covenant-agnostic (they take a server-built unlock and assemble), so ADR-030 needed no new
  transaction builder at all.
- **Signing follows the PROVEN pattern**, not a new one: a per-sale derived holder key
  (`protocolID` STAS, `keyID` slug, counterparty `'anyone'`, `forSelf: true`) used for BOTH
  `getPublicKey` and `createSignature` — the combination already proven on mainnet in
  `settle/twoTx/p2pkhInput.ts`. Using the identity key instead would fail the covenant's checkSig.
- **The manage page now offers an EXPLICIT, labelled choice** between the two curves, showing one
  card at a time and naming the real trade-off (wallet-portable but operator-settled, versus
  unstoppable but ledger-entries-until-graduation). An earlier version offered two look-alike cards
  side by side and a deploy landed on the wrong one; a permanent choice deserves a deliberate UI.
- Sale page renders `variant === 'merkle'` → `MerkleTradeCard`.

Verified: web build clean, 45/45 unit, and the mainnet app e2e still 33/33 through the real actions.

## ADR-030 app wiring (2026-08-27) — the database is no longer the ledger ✅ 33/33 ON MAINNET

The app can now run a trustless pool, and the difference from ADR-027 is the whole point of the
track: **pool state is read from the BLOCKCHAIN, not from our database.**

- **`packages/curve/service/cli.ts`** gains `merkle-genesis` / `merkle-resolve` / `merkle-buy` /
  `merkle-sell-digest` / `merkle-sell-unlock` / `merkle-graduate`. `merkle-resolve` is the important
  one — one call returns the live outpoint, reserve, `sold`, every balance, the root and the full
  history, straight from chain.
- **`apps/web/lib/merkle-ledger-service.ts`** — the child-process bridge (scrypt-ts never enters the
  Next bundle), mirroring `ledger-service.ts`.
- **`apps/web/lib/merkle-ledger-actions.ts`** — deliberately much thinner than `ledger-actions.ts`.
  ADR-027 rebuilt state from recorded Orders, so the operator's DB was authoritative and a reset
  genuinely lost a live pool once. Here the DB stores only the genesis outpoint and the immutable
  terms; Orders are receipts. `markMerklePoolDeployed` re-resolves the outpoint against the chain
  before trusting it, and graduation is deliberately NOT owner-gated because the covenant lets
  anyone trigger it.
- **DB migration `curve_pool_genesis_outpoint`** adds `genesisTxid` / `genesisVout`, kept SEPARATE
  from `poolTxid` on purpose — that field tracks the moving tip for the other variants, and
  overloading it would make a merkle pool unverifiable the moment the tip advanced (exactly how the
  July pool's parameters were lost).
- **Proven on mainnet through the real actions + real Prisma** (`pnpm --filter @launchpad/web
  e2e:merkle`, 33/33): create → deploy → mark → read → buy → **re-read from chain** → holder-signed
  sell → final read → guards. Asserts the DB holds no ledger mirror, and that every balance comes
  back from the chain after each trade.

**New standing practice, now in the harnesses:** download every broadcast transaction back from WoC
and assert on the REAL size/fee/outputs (`service/wocInspect.ts` — `verifiedUnspent`, `inspectTx`,
`reportTx`), and never trust `/unspent` without a `/spent` check. That immediately earned its keep:
the downloaded sell tx showed **3,000 sats at 0.12 sat/B, 12x overpaid**, revealing that
`prepareMerkleSell` never told callers how big the fee input must be — the sell's input is consumed
WHOLE because the covenant pins exactly two outputs. The action now returns **`feeInputSats`**, and
the same sell costs **247 sats at 0.0099 sat/B**. A computed-value-only test would never have shown it.

## ADR-031 (2026-08-27) — no spread on the trustless curve; the fee FLOOR is the real problem

Decided before the external audit, because adding a spread afterwards means a new contract, a
re-audit, and pools stranded on the old script. Modelled against measured numbers
(`packages/curve/service/model-spread.ts`), not argued.

**Decision: NO spread.** The curve stays exactly symmetric. Three measured reasons:
1. **The deterrent already exists** — a round trip costs **7,410 sats** in miner fees at 0.15 sat/B,
   so a 1% spread only dominates above ~741,000 sats per trade.
2. **Revenue is negligible** — 5% on a 30% exit of a 500,500-sat pool is **7,508 sats**, two
   transactions' worth of fee. At 0.5% it is 751.
3. **It costs provable properties** — the `/2` is currently EXACT and solvency is an equality; a
   spread makes it truncate (safely — always toward the pool, and splitting a sell to dodge it
   costs more) but weakens the invariant to `>=` and adds a rounding direction to audit.

**What the model surfaced instead, and it matters more:** the fee floor is **regressive**. A
10,000-sat trade pays **74%** in miner fees; 100,000 pays **7.4%**. ADR-030 bounded the growth, but
the FLOOR stays ~3,705 sats/trade because the ~11.8 KB contract appears twice (successor script +
sighash preimage). **This curve is uneconomic below roughly 500,000 sats per trade** — a real
product constraint not previously stated anywhere.

**Follow-up 1 — ✅ DONE. Fee rate is now 0.01 sat/B, a 15x cut, measured not guessed.**
`service/calibrate-fee-rate.ts` is deliberately two-phase, because acceptance into a mempool proves
nothing and an accepted-but-unmined transaction is WORSE than an overpaid one (it eats the ~25-deep
unconfirmed-chain budget every successor shares). Result: pool-sized (24.7 KB) transactions at seven
descending rates were **all seven MINED in block 964059** — including **0.001 sat/B = 25 sats for
24,699 bytes**.

The rate was deliberately NOT set at that floor — one sample, one mempool condition, asymmetric
failure mode. **0.01 keeps a 10x margin** and still takes a round trip from **7,410 → 494 sats**; a
100,000-sat trade pays **0.49%** instead of 7.41%. Confirmed with a REAL covenant spend rather than
the padded probes: the whole ADR-030 lifecycle re-ran at the new rate (pool `9c4da0cb…:0`, graduation
`876e6f51…`). Defaults updated in `ledgerClient.ts` + `merkleLedgerClient.ts`; Option B's
`CURVE_FEE_RATE` deliberately left alone (it is the shipped path and out of scope here).

**One harness assertion was wrong again, not the code:** the lifecycle's graduation check summed
every output paying the payout SCRIPT, but this harness graduates with its own key, so the
graduator's change lands on the same address and inflated the total (5,862 vs 3,786). On chain,
output 0 was exactly 3,786 — the covenant behaved correctly. The check now asserts **output 0**,
which is the one the covenant actually pins. The stranger-graduates test never showed this because
there the change goes elsewhere.

**Follow-up 2 (not started):** batch settlement, already the Limit B mitigation in the roadmap —
amortises the floor across N buyers at the cost of a semi-trusted sequencer.

## ADR-030 audit gaps (2026-08-27) — four of five closed

Working through the "gaps in our own testing" list in `docs/AUDIT-PREP-MERKLE-LEDGER.md`, cheapest
first, spending sats only where the chain was genuinely required.

- **Script ATTACKED, 34/34** (`service/verify-merkle-adversarial.ts`). The earlier negative tests
  were mostly caught by scrypt-ts simulating the method while BUILDING the unlock — a client-side
  guard, not the covenant, and an attacker does not use our builder. This suite builds a VALID
  unlock then surgically rewrites its bytes: tampered/zeroed/swapped/short siblings, flipped path
  bits, claiming another holder's slot, `isNew` flipped both ways, inflated/deflated
  `oldBal`/`delta`/`newReserve`, redirected and inflated payouts, a third output on a sell, swapped
  outputs, substituted pubkey, three graduation redirections. All repelled; honest baselines still
  validate in the same run.
  **The first version of this suite was WRONG and reported 20 false criticals** — mutating a bsv-js
  `Script.chunks` array does not change `toHex()`, so every "attack" silently re-ran the honest
  spend. The tell was the *shape*: every unlock-tampering case "succeeded" while every
  output-tampering case was correctly repelled — a harness signature, not a vulnerability
  signature. Chunks are now serialised manually and `rewrite()` throws if a tamper produces
  identical bytes. Recorded in the BSV field notes.
- **DEPTH boundary + 8-byte balance ceiling, off-chain** (45/45): slot 65,535 proves against the
  same root as slot 0, path bits round-trip across the full index range, the balance ceiling THROWS
  rather than wrapping, and neighbouring balances stay distinct. Noted as a **deploy-time
  constraint**: nothing on-chain bounds `k` or `supply`.
- **Multi-slot holders PROVEN on mainnet, 12/12** (`verify-merkle-multislot-mainnet.ts`, pool
  `baf0d0e3…:0`). A holder was given two slots by hand — deliberately doing what a third-party
  client might — then sold from each. Reconstruction found all three slots, aggregated the
  duplicate holder correctly, kept `sold == Σ balances`, and byte-matched the tip. Both design
  claims confirmed live.
- **Still open (correctly):** genuine randomised/mutational fuzzing of the Script, and a formal
  argument that the off-chain and in-script Merkle folds are equivalent. Both are named in the
  audit doc as work for the external auditor.
- Wallet funded to 500k sats; this arc spent ~28k.

## ADR-030 audit package (2026-08-27) — `docs/AUDIT-PREP-MERKLE-LEDGER.md` + solvency suite (41/41)

The audit doc we had described the ADR-027/Option B covenant. ADR-030 is a **different contract
with a different trust model**, so it gets its own package rather than an edit — findings do not
transfer between them, and both docs now say so.

- **Trust model is materially simpler to audit:** there is **no operator key anywhere** in ADR-030.
  Buy is keyless, sell is holder-signed, graduation is permissionless to a destination fixed at
  deploy. So there is no key-compromise drain vector — all risk sits in covenant logic.
- **Covers** 12 money-critical invariants, 7 ranked drain vectors, and — deliberately — the
  **accepted design properties** an auditor should call out rather than silently "fix", plus a
  **"gaps in our own testing"** section (the Script has not been fuzzed; fold equivalence is tested,
  not proven; multi-slot holders untested on mainnet; DEPTH boundary unexercised; the 8-byte balance
  ceiling untested).
- **New: `test/merkle-solvency.test.mjs`.** ADR-027 had 13/13 adversarial drain tests and ADR-030
  had none — an audit package that omitted that would have claimed more assurance than existed.
  Now 41/41 total, including a 40-seed buy/sell fuzz asserting the invariants after EVERY operation
  and a full-exit test proving the reserve returns to exactly the seed.
- **Two findings from writing it, both now in the contract comments and the doc:**
  1. **The curve's `/2` never truncates** — `d·(2s+d+1)` is always even — so there is no rounding
     in anyone's favour, anywhere.
  2. **Buy and sell are exact inverses, so the pool has ZERO spread.** It is precisely solvent,
     never over-collateralised, and **nothing but miner fees discourages wash trading**. That is a
     product decision to make consciously, not a bug.
  Both contracts previously carried a "rounded against the seller" comment, which was wrong. The
  ADR-030 comment is corrected; the edit was verified **inert** by recompiling and confirming the
  script hex and ABI are byte-identical, so the deployed pool is unaffected.

## ADR-030 open client (2026-08-27) — reconstruction + client ✅ (16/16 from chain · 24/24 offline)

The bounded-size covenant is now a first-class protocol target, not just a contract:

- **`src/merkleLedgerReconstruct.ts`** — parses an ADR-030 spend back into its op. Unlike the
  ADR-027 parser it must also recover the **slot index** and the **append flag**, because this
  covenant addresses balances by slot: reconstructing by "the owner's first slot" would be a guess,
  and an open protocol means another client may legitimately append a second slot for an existing
  holder. Layout verified against real compiled output, not assumed
  (buy 39 chunks / `OP_0`; sell 40 / `OP_1`; graduate 2 / `OP_2`).
- **`service/resolveMerkleLedgerPool.ts`** — DB-free resolution: live outpoint, reserve, `sold`,
  `holderCount`, per-slot and per-holder balances, the Merkle root, and the full history. The walk
  is self-verifying per hop, guards WoC's mempool lag on the tip, and refuses to report an
  unparseable spend as a graduation.
- **`service/merkleLedgerClient.ts`** — `MerkleLedgerPoolClient`, the ADR-030 twin of
  `LedgerPoolClient`: `state`/`quoteBuy`/`quoteSell`/`quoteSellFee`/`balanceOf`/`buildBuy`/
  `buildSell`/`buildGraduate`/`submitBuy`/`submitSell`/`broadcast`, plus `genesisScript(terms)`.
  Never sees a key; every build re-resolves and interpreter-checks the bytes; carries the same
  "loser re-signs" contention loop.
- **One design correction while wiring it:** slot re-derivation was happening in three places. All
  paths now funnel through `normalizeOps`/`replayMerkleSlots`, so a history read off the chain is
  replayed by its RECORDED slots and only a history we authored gets slots assigned by policy.
- **Proven against the live mainnet pool from yesterday** (`4c6faf97…:0`) at **zero sats cost** —
  reads only: 6 hops, terminal graduation detected, exact history `slot0*+25 slot1*+25 slot0+10
  slot0−11 slot1+31`, A=24, and **holder B (`1957fa7a…`) recovered from chain alone** (that key was
  random and no longer exists locally). `service/verify-merkle-resolve.ts`, 16/16.
- Parser round-trip guards added to the offline suite (now **24/24**) so a regression is caught
  without needing a live pool.
- Test wallet untouched today: **~44k sats**.

## ADR-030 (2026-08-26) — bounded-size Merkle ledger ✅ MAINNET-PROVEN (6/6 live · 16/16 offline · 14 tree tests)

**Limit A is solved.** The ADR-027 ledger embedded every holder in the covenant; measured, that is
~64 B of script per holder, present in BOTH the successor script and the sighash preimage — ~128 B
per holder per trade, a ~150 KB transaction at 1,000 holders. The fee was survivable; the real cost
was that reconstruction downloads every hop, so client verification grew as **O(trades × holders)**.

Replaced by a **32-byte Merkle root** over a fixed-depth (16) array of holder slots plus a
`holderCount`, with a **512-byte inclusion proof** per spend — constant in holder count.

- **Measured on mainnet: the locking script is 11,864 B at EVERY step**, holders notwithstanding
  (`service/verify-merkle-mainnet.ts`, pool `4c6faf97…:0`, k=1 supply=80): deploy → append A
  (`676a7baf…`) → append B (`41056d43…`) → **update A's existing slot** (`0ad2a6af…`) →
  holder-signed sell (`5caf3de5…`) → buy out (`44f2b5dc…`) → **graduate** (`9c5c114d…`, full
  3,786-sat reserve to the committed payout). HashedMap at the same point: 10,884 + 64·holders.
- **Indexed slots, not a pkh-keyed SMT** — a 160-bit key needs a 160-level path (~5 KB proofs) or a
  compact bitmap encoding that is much harder to verify in Script, and this is already the largest
  audit surface in the system. Slot indexing gives a 16-step sha256 loop.
- **It removes a whole class of bug.** `LedgerPool.buy` needed an `isNew` flag plus a
  NON-MEMBERSHIP proof, because `HashedMap.set` could otherwise overwrite a live balance and break
  `sold == sum(balances)` — a reserve drain. Here every spend proves the CURRENT value of the slot
  it touches, so nothing can be reset; a new holder proves the slot at exactly `holderCount` is
  EMPTY. Duplicate slots for one holder are harmless (the sum is conserved). It also removes the
  per-spend **history replay**, since state is now three scalars.
- **The scrypt-ts successor trap bit again** — building an instance via the CONSTRUCTOR with the
  desired state yields a script that does not byte-match the chain, and the covenant's `hashOutputs`
  check fails. Must construct at genesis then MUTATE (same lesson as ADR-027's replay); now
  documented in `merkleLedgerState.ts`.
- **New tooling:** `service/measure-ledger-size.ts` (the measurement behind the ADR) and
  `service/consolidate-test-wallet.ts` — the harnesses fund a run from a SINGLE input, so a
  fragmented wallet fails with "no verified-unspent UTXO > N" while holding plenty.
- **Limit B is untouched:** this bounds SIZE, not throughput. ~25 trades per confirmation window
  per pool still stands.
- **Test wallet is low: ~44k sats left** (156,820 at the start of this arc). Enough for one more
  modest mainnet run, not several.

## Trustless track · phase 5a (2026-08-26) — permissionless GRADUATION ✅ PROVEN ON MAINNET (15/15)

Graduation was the last covenant path never driven on a live pool. It is now closed, and with it
the **full lifecycle: deploy → buy → sell → graduate, all on mainnet.**

- **A STRANGER graduated the pool.** Pool `75f84209…:0` (k=1, supply=24) was bought out to exactly
  `sold == supply` (A +14, B +10), then graduated by a **freshly generated key holding no tokens,
  no operator role and no relationship to the pool** (`82e5dd53…`). No signature is required by the
  covenant — that is the point.
- **The graduator could not touch the money.** Verified against the on-chain tx: the full **846-sat
  reserve went to the payout committed at deploy**, output 0 is the payout (pinned by the covenant),
  **nothing leaked to a third destination**, and the stranger was **net −1,727 sats** — it *paid* to
  graduate and extracted nothing.
- **The final ledger survives the pool UTXO.** After graduation `resolveLedgerPool` still returns
  `graduated: true` plus every holder balance — exactly the list real STAS is minted against.
  Losing it would strand every contributor, so this is asserted explicitly.
- Guards proven: cannot graduate before sell-out, cannot buy past a sold-out curve, cannot graduate
  twice.
- **Two code improvements this surfaced:** `buildGraduate` now lets the graduator take **change**
  (ANYONECANPAY|SINGLE pins only output 0), so triggering a graduation costs a stranger a fee rather
  than their entire UTXO — a permissionless action shouldn't carry a needless disincentive. And
  `resolveLedgerPool` no longer reports *any* unparseable spend as a graduation: it confirms the
  spend really pays the committed payout the full reserve, so a parser gap can't masquerade as
  "the sale completed".
- **Honest note on the first run (12/13):** the one failure was a **bad assertion in my test**, not
  a defect — it compared the graduator's own change against the reserve, two unrelated amounts. I
  verified the actual property against the recorded chain data, rewrote the assertion to test what
  matters (graduator net-negative, no third destination, payout ≠ graduator), and re-ran the whole
  flow live for a clean **15/15**.
- Mainnet spend across phases 2–5a: **~67k sats** (156,820 → 89,562).
- **Next: the SMT migration** (Limit A — tx size is O(holders); pool txs are already ~22 KB).
  Still open besides that: decentralised discovery, and Limit B (~25 trades/window/pool).

## Trustless track · phase 4 (2026-08-26) — permissionless sequencing ✅ PROVEN UNDER REAL CONTENTION (14/14)

The single hot pool UTXO no longer needs an operator to sequence it.
`LedgerPoolClient.submitBuy` / `submitSell` wrap a build in a bounded contention loop: on an
outpoint-move rejection the client **re-resolves the tip, rebuilds, re-signs** and retries.
Ordering is decided by the network, not by any privileged party.

- **`isOutpointConflict()`** separates a race (`txn-mempool-conflict`, `Missing inputs`,
  `txn-already-known`) from a genuinely invalid spend, which is surfaced immediately — the loop
  must not mask real bugs, and a test asserts exactly that.
- **Proven with actual conflicting broadcasts on mainnet** (`verify-sequencing-mainnet.ts`, pool
  `31820de7…:0`, k=1 supply=200): two holders built buys against the SAME tip; A landed
  (`d1902f08…`) and B's pre-built tx was **rejected by the node with `258: txn-mempool-conflict`**,
  then recovered in 2 attempts (`d3bdfb7f…`). Then a SELL race — B moved the tip under A's sell and
  A rebuilt, **re-signed** and landed (`3fa3af76…`); the test counts signatures and asserts one
  fresh signature per attempt, which is the "loser re-signs" property directly. Final ledger: 4 ops
  replayed (`+40 +20 +10 -11`), none lost, reconstruction byte-matched the tip.
- **Honest consequence, now in the API:** a rebuilt trade is **re-priced at the new curve
  position** — observed live, B's buy went 210 → 1010 sats, and A's sell refund went 605 → 715 (a
  loser can be repriced either way). The covenant won't honour a stale quote, so a UI should
  re-quote and confirm rather than blindly retry; `submit()` returns `attempts` and `repriced`.
- **All three protocol properties from the roadmap §1 are now met** for the ledger pool. The
  operator's role on the trade path is zero.
- **Still open (not protocol-completeness):** permissionless graduation is *built* but never driven
  end-to-end on a live pool; discovery still needs a genesis txid from somewhere; the SMT migration
  (Limit A, tx size is O(holders)); and Limit B — **~25 trades per confirmation window per pool**,
  which contention recovery does NOT change (it makes losers land eventually, not faster).
- Mainnet spend across phases 2–4: **~54.5k sats** (156,820 → 102,306). Research track — does not
  block the shipped Option B.

## Trustless track · phase 3 (2026-08-26) — open client `LedgerPoolClient` ✅ MAINNET-PROVEN

The "anyone can build a UI over it" boundary now exists as code:
`packages/curve/service/ledgerClient.ts` — `LedgerPoolClient(genesisTxid, {k, supply, payoutPkh})`
with `state()` · `quoteBuy/quoteSell/quoteSellFee` · `balanceOf` · `buildBuy` · `buildSell` ·
`buildGraduate` · `broadcast`, plus `LedgerPoolClient.genesisScript(terms)` to open a pool.

- **Depends on nothing of ours** — no server actions, no Prisma, no operator, no stored state.
- **Wallet-agnostic, never sees a key.** Callers pass a funding input + an @bsv/sdk
  `UnlockingScriptTemplate` (`new P2PKH().unlock(priv)`, or a BRC-100 adapter), and for sells a
  `Holder` that signs one 32-byte digest — that signature IS the claim to the balance.
- **Safe by construction:** every build re-resolves state from chain and runs the assembled bytes
  through the interpreter, so a client can't broadcast a spend the covenant rejects, or build
  against a tip it read earlier.
- **Full mainnet round trip using ONLY the client** (`verify-open-client-mainnet.ts`): OPEN
  (genesis `84e72674…:0`, k=1 supply=60) → READ (sold 0) → BUY 40 keyless (`c6e1b0dc…`) → RE-READ
  from a *second* client built from scratch → SELL 25 holder-signed, **no operator co-signature
  anywhere in the path** (`2e8cf89a…`) → a *third* fresh client rebuilds it and **byte-matches the
  on-chain tip** → 4 guards (refuses overspend / beyond-supply / underfunded / dust refund).
  Final 20/20 (one run showed 19/20 — a wrong constant in the test, not the code: `hops` equals the
  op count, 2 here, and I'd copied 3 from the 3-op phase-2 pool).
- **Protocol constraint surfaced:** a sell's fee input is consumed WHOLE (0xc1 pins exactly two
  outputs → no change), so sellers must pre-size an exact fee UTXO — `quoteSellFee()` returns it and
  the harness demonstrates the two-tx flow.
- **Two live-run lessons:** (1) the sell fee estimate double-counted the pool script (once in the
  preimage, once in the successor) and demanded ~50% too much — caught before broadcast, cost
  nothing; there's now a drift check asserting the real sat/byte rate. (2) WoC `/unspent` listed an
  already-spent output → `258: txn-mempool-conflict`; the harness now verifies candidates against
  `/spent` first (the field-note rule) and accepts unconfirmed change.
- **Properties 1 and 2 of 3 met.** Next: phase 4, permissionless sequencing (the "loser re-signs"
  contention loop). Research track — does not block the shipped Option B.
- **Reference pools + total mainnet spend (~24.5k sats) recorded in the roadmap** so every pool
  stays re-verifiable — the July pool became unverifiable when a DB reset lost its terms.

## Trustless track · phase 2 (2026-08-26) — `resolveLedgerPool` ✅ MAINNET-PROVEN (10/10)

Pool state now resolves **from WhatsOnChain alone — no operator DB**:
`packages/curve/service/resolveLedgerPool.ts` returns the live outpoint, reserve, `sold`, every
holder balance and the full op history from just `(genesisTxid, k, supply, payoutPkh)`.

- **Self-verifying walk.** Each hop recomputes the expected successor from the ops parsed so far
  and matches an output **byte-for-byte** — so the successor needs no prefix heuristic, a misparse
  fails at its own hop, and graduation is detected naturally.
- **Proven on a live mainnet pool** (`packages/curve/service/verify-reconstruct-mainnet.ts`):
  deployed genesis `3e247404…:0` (k=1, supply=100), wrote a real 3-op multi-holder history —
  A +40 `fb7197f7…`, B +20 `0bbe4c40…`, A −30 holder-signed `888f3724…` — then rebuilt it from the
  genesis txid and nothing else: **reserve 1011, sold 30, A=10, B=20, reconstructed lockingScript
  byte-matched the on-chain tip.** Holder B's pkh `275532e2…` was recovered **from chain alone**
  (its key was a throwaway that no longer exists locally). Cost ~11k sats; every broadcast gated on
  `validateAssembledCovenantInput` (the interpreter over the exact bytes), with a `--dry` mode.
- **WoC quirk found + handled (cost one failed run):** `/tx/{txid}/{vout}/spent` returns the same
  404 for a genuinely-unspent output and for one whose spend is in the mempool but **not yet
  indexed** — so a read moments after a trade reports a **stale tip and a short history**. The
  resolver now re-checks an apparent tip before concluding (`tipRechecks`, default 2). Added to the
  BSV field notes (it generalises past this repo).
- **Keep this pool's params** — the July ledger pool became unverifiable when a DB reset lost its
  outpoint/terms. Re-verify any time:
  `node packages/curve/service/dist/service/verify-reconstruct-mainnet.js --resolve <genesisTxid>`.
- **Protocol property 1 of 3 ("on-chain is the source of truth") is met** for the ledger pool.
  Next: phase 3, the open client library. Research track — does not block the shipped Option B.

## Trustless track · phase 1 (2026-08-26) — ledger reconstruction linchpin ✅ BUILT + PROVEN (branch `trustless-ledger-reconstruct`)

The trustless upgrade beyond Option B (a bonding-curve **protocol** anyone can build a UI over —
`docs/TRUSTLESS-LEDGER-ROADMAP.md`) has its **phase-1 linchpin done and offline-proven**: the ADR-027
ledger pool's state can be reconstructed **from chain alone, no operator DB**.

- **What was built:** `packages/curve/src/ledgerReconstruct.ts` — `parseLedgerOp(unlockHex)` parses a
  spent pool covenant input into its op `(ownerPkh, delta)` (layout verified vs real scrypt-ts output:
  buy selector `OP_0`, delta@chunk 3; sell selector `OP_1`, amount@chunk 4 → `delta = −amount`;
  graduate `OP_2` terminal). `reconstructLedgerHistory(genesisTxid, fetchSpendOf)` walks the successor
  chain feeding those ops to the already-mainnet-proven `replay()` (now also exported as
  `poolScriptForHistory` in `service/ledgerState.ts`).
- **Proof (offline, no network):** `packages/curve/service/verify-reconstruct.ts` **17/17** — build a
  real buy/sell/repeat-buy/sell-to-zero op sequence via the app's own code paths → collect the on-chain
  unlock scripts → reconstruct from the scripts alone → the rebuilt `lockingScript` **byte-matches the
  successor tip**, both by direct parse and by a genesis→tip chain-walk with an injected `fetchSpendOf`.
  `@launchpad/curve` typecheck clean, 19/19 existing tests green.
- **Why it matters:** the operator's database is now provably **non-authoritative** for the ledger
  pool — the first of the three protocol properties (on-chain source of truth). This is a research
  track, separate from and not blocking the shipped Option B (below).
- **Next (phase 2):** back `fetchSpendOf` with a real WhatsOnChain spent-lookup + tx-fetch
  (`resolveLedgerPool(genesisTxid)`, DB-free) and prove it against a **real mainnet ledger pool**;
  handle WoC tip reorgs + spent-lookup lag there. Then the open client (phase 3).

## Decision (2026-08-26) — Option B is the launch curve · atomic buy (ADR-029)

After the strategy synthesis (`docs/research/decentralized-funding-strategy.md`), the go-forward
shape is set: **ship the hybrid Option B (ADR-028) as THE bonding curve**, with real wallet STAS,
and **defer** the trustless in-covenant ledger (ADR-027 B-ledger), batching, and Dutch/batch auctions.

- **BUY → SPLIT (TX-A + TX-B), already built.** _Atomic buy was evaluated and found **INFEASIBLE**
  with classic STAS (2026-08-26): the covenant tolerates it (0xc3 SINGLE only pins output-at-its-index;
  proven `packages/curve/service/verify-atomic-buy.ts` 4/4), but the STAS token input's **single-change
  rule** rejects the extra reserve-covenant successor output — the same wall that made the sell two-tx.
  See ADR-029 correction._ So keep TX-A (buyer-signed reserve buy) + TX-B (operator STAS delivery);
  buyer's 0x41 binds TX-A's single output (anti-shortchange). Mitigate the paid-but-undelivered window
  operationally: robust + monitored delivery + the idempotent "Complete delivery" recovery.
- **SELL → unchanged (ADR-028):** holder signs return, fail-closed provenance/back-to-genesis, operator
  co-signs; covenant caps payout + pins successor.
- **Honest trust model (label in-product):** trustless *pricing* both ways; *operator-assisted* token
  movement both ways (operator can stall, never mis-price/divert). **Compromised operator key = full
  reserve drain** → HSM-grade custody is mandatory, or don't ship Option B.
- **Fee-fuel hardening — ✅ tool built (2026-08-26):** `apps/web/scripts/operator-fuel.mjs`
  (`pnpm --filter @launchpad/web operator:fuel`). `status` = health report of the flat-key base
  address (confirmed vs unconfirmed, verified-unspent via the 404=unspent spent-check, warns if all
  fuel sits in one UTXO); `split [K] [dry]` = split the largest confirmed UTXO into K shallow fuel
  outputs (base→base, flat-key/@bsv/sdk P2PKH, 0.1 sat/byte, WoC broadcast) so a burst fans across
  parallel UTXOs instead of chaining one 25-deep. Verified: status reads 1D86 live; split dry-run
  builds+signs correctly (14307→7×1788+change). `drain <address> [dry]` = sweep ALL confirmed base
  sats to an address (recover test funds; dry-verified 3 UTXOs→1 output). CPFP-a-stuck-chain deferred
  (the fee-fix already prevents new stuck txs; the old jam self-cleared). NOT auto-run (money decision).

## Verification discipline (2026-08-26) — REAL mainnet round-trips, not mocks

Money-critical on-chain code is verified on mainnet, not just offline. The self-driving harness
`apps/web/scripts/e2e-stas.mjs` + `scripts/lib/flat-key-wallet.mjs` (`FlatKeyWallet`) reads the server
flat key (`OPERATOR_KEY`, gitignored `.env`) and plays EVERY wallet role from the base address over
WhatsOnChain — no BRC-100/BSV Desktop — running the full `deploy→mint→buy→deliver→sell→refund` on
mainnet with real sats, logging each `▶ STEP` + txids + balances. Offline suites (`verify-stas` 33/33,
`verify-atomic-buy` 4/4) are the fast pre-check; the harness is the truth (every deep bug — fee eviction,
toolbox corruption, BEEF fragility, sold=0 brick — was caught by real txs). Loop: fund base → `operator:fuel
split` → run harness (background) → read log → fix → re-run → `operator:fuel drain` to recover. Honest
limit: the harness plays buyer AND operator with one key (proves on-chain mechanics, not the real
two-party BRC-100 boundary — occasional real-wallet UI tests still matter). Key safety: it is a hot,
burnable SERVER flat key (never the user's seed), fund small, never handled in chat.

**TWO-WALLET (real two-party) harness (2026-08-26):** the harness now drives TWO separate flat keys so a
run is a genuine client↔operator test (not one key playing every role). `TEST_CLIENT_KEY` (gitignored
`.env`, generate/show via `pnpm --filter @launchpad/web test:client`, address printed only) plays the
CLIENT roles — admin deploy+mint, buyer payment, seller STAS return — funded from the CLIENT base
address; `OPERATOR_KEY` (`1D86…`) stays the operator (delivery+refund co-sign, reserve+vault, operator
fees). STAS flows client→operator vault→client; the sell refund pays the CLIENT address; both balances
are gated at start (`MIN_CLIENT_SATS` / `MIN_OPERATOR_SATS`). This keeps the operator reserve separate
from client test spend AND exercises the real two-party boundary. Client test address (2026-08-26):
`12emJJaphDvZXH5krKuyiaC1ELecH1G3xT` — fund it to run. Operator top-up FROM the client:
`pnpm --filter @launchpad/web client:topup [-- <sats>]` (`scripts/client-topup-operator.mjs`) moves a
fee reserve client→operator so no separate operator send is needed.

**✅✅ TWO-PARTY ROUND-TRIP PROVEN ON MAINNET (2026-08-26)** — separate client + operator wallets,
clean per-wallet accounting: mint contract `0544c94c` (issuance `c1f2f380`) → buy TX-A `c7d11775`
(client/buyer) → deliver TX-B `c9ec6a1e` (operator) → sell TX1 `026a95f8` → back-to-genesis
`authentic:true` → refund TX2 `6f974890` (→ CLIENT, seller=client). **Client Δ −3,095 sats**
(seed 546 + mint/buy fees), **operator Δ −1,141 sats** (delivery+refund fees only — never the client's
funds). ~4.2k/round-trip (546 seed recoverable from the throwaway pool). Client funded 200k → ~40+ runs.
Robust under back-to-back runs (2 consecutive passed; spendable balance dips as change goes deep-unconfirmed
then self-heals on confirmation — `operator:fuel split` gives parallel shallow roots for sustained bursts).

## ✅✅✅ FULL-STACK REAL-PRODUCT LIFECYCLE PROVEN ON MAINNET (2026-08-26)

`apps/web/scripts/e2e-app.mjs` (`pnpm --filter @launchpad/web e2e:app`) drives the **REAL Next.js
server actions + REAL Prisma DB + mainnet** — the actual code the app's buttons call — NOT the
covenant-only `e2e-stas` harness. It stubs ONLY Next's cache/routing/cookies (`scripts/lib/stub-next.mjs`,
an ESM loader that intercepts `server-only`/`next/cache`/`next/navigation`/`next/headers` with no-ops) so
the `'use server'` actions import into a plain tsx script; everything else is real. Two-party: CLIENT
flat key = owner/admin/buyer/seller (via `FlatKeyWallet`), OPERATOR key co-signs delivery+refund INSIDE
the real `deliverStasToBuyer`/`finalizeStasSell`. **Passed FIRST run (2026-08-26):** create project
(`createProject`) → approve (`setProjectStatus`) + `updateSaleEscrow`→bonding_curve → deploy
(`createStasPool`+`markStasPoolDeployed`) → mint (`prepareStasMint`+`issueStasGenesis`+`recordStasMint`,
issuance `5877a5ba`) → buy (`prepareStasBuy`/`recordStasBuy`→Order→`deliverStasToBuyer`, delivery
`55dba34c`) → sell (`prepareStasSell`/`recordStasSell`/`finalizeStasSell`, return `ed5d5144`, refund
`be580900`). Writes the real DB, so the project shows in the app: **`/sale/e2e-app-1787740581904`**.
Client Δ −3,094 · operator Δ −2,282. This validates the real server-action + DB orchestration, not just
the covenant. Remaining human step: the on-screen UI pass (browser + BSV Desktop) — the one layer that
can't be automated (UI hard-wires the BRC-100 `WalletClient`).

**✅ MANUAL UI PASS COMPLETE (2026-08-26)** — the maintainer ran the full flow in the running app with a
real BRC-100 wallet (BSV Desktop): create project (`testa`) → admin approve → deploy STAS pool → mint →
buy 5 (delivered) → sell 5 (return `78824279` + operator refund `9a1bf00c`), pool back to sold 0 / reserve
546. Both the automated (`e2e:app`) and manual (UI) passes now confirm the product end-to-end on mainnet.
Three real UI issues surfaced + fixed during the pass: (1) **STAS pools were graduating** on sold-out and
the sale page showed "sale isn't open yet", blocking sells — fixed: a sold-out STAS pool stays `live`
(buying capped by supply, selling open), since buyers already hold real wallet STAS (nothing to graduate
to). (2) The manage page offered TWO deploy cards (trustless ledger/linear + wallet-STAS) and the wrong one
is easy to click — removed the ledger/linear card; the wallet-STAS card is the only deploy option (ADR-029).
(3) Default demo supply 5 → 25 so one buy doesn't instantly sell out. Also set `ADMIN_SECRET` in `.env`
(needed for /admin). UX follow-ups noted: sold-out state could show "sold out — selling open" explicitly;
the "register settled purchases" panel display when already delivered.

## ✅ Open items worked through (2026-08-26)

Post-PR (#1) close-out of the ADR-029 launch open items:
- **Operator key → HSM/KMS**: signer made pluggable (see below). ✅ code; human provisions the HSM.
- **UX polish**: sold-out trade-card state ("buying closed, sell open" + shortcut); live pill fixed
  (was two dots — static `.pill::before` + pulsing — now only the pulsing one). ✅
- **Automated sweep trigger**: `CRON_SECRET` set + `apps/web/vercel.json` schedules
  `/api/cron/sweep-deliveries` every 2 min (Vercel sends the bearer the route checks). ✅
- **External audit**: prep doc `docs/COVENANT-AUDIT-PREP.md` (audit surface, invariants 1–8, drain
  vectors, evidence, out-of-scope). ✅ prep; the audit itself is external and gates any real reserve.
Remaining human/infra: run the audit; provision the HSM + signer; deploy + set the production envs.

## 🔐 Operator key → HSM/KMS ready (2026-08-26)

The operator co-sign key (the reserve-security boundary, ADR-029) signing is now PLUGGABLE
(`apps/web/lib/operator-wallet.ts`), selected by `OPERATOR_SIGNER`: `local` (default —
`OPERATOR_KEY` in `.env`, dev/testing) or `remote`/`kms`/`hsm` (production — POST the 32-byte
digest to an HSM/KMS-backed endpoint `OPERATOR_SIGNER_URL`; the private key never enters the
app; `getOperator()` reads the public `OPERATOR_PUBKEY`). Low-S canonicalization applied to BOTH
backends. No call sites changed. Verified: local mode still yields valid low-S sigs with the SAME
pkh `84f96c45…` (all existing pools + the harness keep working). Provider recipes (AWS KMS
ECC_SECG_P256K1, GCP, YubiHSM), the HTTP contract, the **pubkey-must-match-deployed-pools** migration
note, and the honest caveat (HSM protects key material, not signing authorization → give the signer
its own policy) → `docs/OPERATOR-KEY-CUSTODY.md`. Remaining (human/infra): provision the HSM/KMS +
signer service, set the envs, verify `getOperator().pkh` matches the pools' `operatorPkh`.

## 🏗️ Delivery robustness (in progress, 2026-08-26)

Shrinking/auto-recovering the split-buy paid-but-undelivered window. **Piece 1 — auto-sweep ✅ built +
PROVEN ON MAINNET (via `e2e:app`, 2026-08-26):** a real stuck paid-but-undelivered order (buy recorded,
delivery skipped) was detected by `getPendingStasDeliveries` and self-healed by `sweepPendingStasDeliveries`
(swept 1, delivered 1, DB order → `settled` with delivery txid `b76c8553`). Also hardened the broadcast
path: `broadcastRawTx` now backoff-retries transient WoC 429/5xx/network (definitive rejects still return
immediately) — a production robustness win. **Piece 2 — monitoring ✅:** the sweep now writes a
`stas_delivery_sweep_failed` Event (entity `Order`) for any delivery it couldn't complete, so persistent
stuck deliveries are queryable, not just returned in the response. **Piece 3 — automated trigger ✅ built:**
`apps/web/app/api/cron/sweep-deliveries/route.ts` — a `CRON_SECRET`-gated (or admin-session) GET/POST that
calls `sweepPendingStasDeliveries` with a small per-call limit (default 5, cap 25) so each tick finishes
fast; schedule it (Vercel cron / any external cron hitting `?secret=$CRON_SECRET`) to self-heal stuck
deliveries with no human. Set `CRON_SECRET` in `apps/web/.env` before scheduling. Web typecheck green.
The route wraps the mainnet-proven sweep; the full cron→route→sweep chain is verifiable by running the app.
Delivery robustness is functionally complete (auto-sweep + monitoring + automated trigger); optional
follow-up: a dedicated admin "Sweep deliveries" button (the route already accepts an admin session).
Earlier build note below.
`sweepPendingStasDeliveries({ saleId?, limit? })` (`apps/web/lib/stas-actions.ts`) completes EVERY stuck
`curve_buy` (pending/settling, `paymentTxid` set, `txid` null), oldest-first, delegating each to the
idempotent `deliverStasToBuyer` — so a stuck buy self-heals without the buyer clicking "Complete delivery".
SEQUENTIAL (each delivery spends+advances the single vault UTXO), BOUNDED (`limit` default 25), continues
past a failing delivery, idempotent (never double-delivers). NOT buyer-scoped → the caller MUST gate it
(operator/admin ADR-020, or a trusted cron). Web typecheck green. The on-chain delivery mechanic is already
mainnet-proven (harness); the sweep adds DB orchestration over it — app-level test (seed a stuck order →
sweep → deliver) is next. **Remaining:** (2) broadcast-retry hardening in deliverStasToBuyer, (3) delivery
attempt/failure monitoring events, (4) wire a trigger (admin control or cron).

**✅ FRESH FULL ROUND-TRIP RE-PROVEN ON MAINNET (2026-08-26):** deploy `ffbda423` → mint (issuance
`ded13344`) → buy TX-A `92ec2bec` → deliver TX-B `21478e23` → sell return TX1 `6b0f4f03` (back-to-genesis
`authentic:true` [2 nodes]) → refund TX2 `f5455d48`. Found + fixed via the loop (run→fail→fix→re-run, 4
runs): THREE stale spots where the pre-mortem's mandatory `fetchIsUnspent` (FIX-1) had not been
propagated into TEST code — (1) `flat-key-wallet.mjs` `createAction`, (2) e2e-stas DELIVER
`selectOperatorFeeInputs`, (3) e2e-stas REFUND `buildStasSellRefundTx`; plus a real robustness fix in the
shim: it now tracks its own just-created base CHANGE (`_created`) and feeds it into selection (guarded by
a WoC spent-check for operator-path contention) so a step can spend the prior step's change BEFORE WoC
indexes it (the 2s inter-step sleep was not enough). **PRODUCTION path was already pre-mortem-consistent**
(`deliverStasToBuyer`/`finalizeStasSell` were updated); only the harness/shim had drifted — and the run
exercises the REAL production packages (covenant, `buildStasBuyTx`, `operatorDeliverStas`,
`buildStasSellRefundTx`, `selectOperatorFeeInputs`), so this validates production, not just the harness.
- **Remaining to ship (not new covenant R&D):** delivery robustness +
  monitoring so the paid-but-undelivered window is tiny and always recoverable, operator key hardening
  (HSM-grade), STAS-in-BSV-Desktop registration, external covenant audit before any real reserve.
  (Atomic-buy assembly is OFF the list — infeasible with STAS, see ADR-029 correction.)

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

**✅ L2 ESCROW PRESALE — built 2026-07-29 (ADR-025), PROVEN ON MAINNET 2026-08-31 (see ADR-033 for what the run exposed and fixed).** Trustless
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
