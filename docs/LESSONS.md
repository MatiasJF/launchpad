# Lessons — what has gone wrong here

`DECISIONS.md` records *why things are the way they are*. This file is the other shape: **distilled and read
before you start**, so a mistake made once is not made again.

**This file is for findings specific to the Launchpad.** Anything about the chain, an SDK or the toolchain
that would help *any* BSV project belongs in **`~/.claude/bsv-field-notes.md`** — it lives outside every
repository and is loaded in all of them. Putting a general lesson in a project file is how the next project
rediscovers it.

Add an entry with **`/lesson`**, and only when something **surprised** you: a symptom that pointed at the
wrong cause, a tool behaving differently than documented, a test that passed while wrong, money moving
unexpectedly, or a fix that needed a second attempt. Routine work does not belong here — this file dies the
day it fills with things everyone already knew.

Write **symptom first**, because the symptom is what the next person has in front of them and the cause is
what they cannot see. Include what it cost.

---

## Already true here, carried over

These were verified on mainnet in the sibling prediction-market project. They are listed because this
codebase shares the chain, the wallet stack and the toolchain — not because they have been hit here yet.
The detail is in `~/.claude/bsv-field-notes.md`; read that before touching anything that spends.

- **`Missing inputs`** means the output does not exist. **`258: txn-mempool-conflict`** means something
  already spends it. Neither is a signing problem — look at the UTXO.
- **WhatsOnChain's `/address/{addr}/unspent` returns outputs that are already spent**, including ones
  confirmed in a block long ago, with no flag. Verify candidates against `/tx/{txid}/{vout}/spent` before
  spending them, or the first broadcast of a fresh process is refused as a double spend.
- **A rejected transaction pays no fee.** Failed broadcasts cost nothing — worth saying to anyone who thinks
  they just burned money.
- **`@bsv/wallet-toolbox` runs `dotenv.config({ override: true })` at import**, silently overwriting the
  running process's environment — including variables set on the command line.
- **Node 22 is a floor** wherever `better-sqlite3` is involved: on Node 20 it segfaults (exit 139) rather
  than failing cleanly. `pnpm rebuild -r` after any Node switch.
- **Check a process's age before believing its output.** `ps -o etime= -p $(lsof -ti :PORT | head -1)`.
  Anything older than your last change is not running your last change, and `EADDRINUSE` is silent from
  outside — the health check passes because *something* is answering.

---

## Launchpad-specific

### Single-UTXO bonding curves hit a serialization wall under moderate load

**Symptom**: After ~10-25 concurrent curve buys (unconfirmed), the next buyer's delivery fails with `"all N operator base UTXO(s) have deep unconfirmed ancestry — wait for confirmation or fund from fresh source to avoid too-long-mempool-chain"`. Order stays stuck in `pending` state (buyer paid, tokens not delivered). OR two simultaneous buys: one gets `258: txn-mempool-conflict`, the other succeeds, first buyer wasted gas on TX1 funding and must retry from scratch.

**Cause**: Every buy spends the same single pool UTXO to create a successor (linearCurvePool.ts:14 "a single evolving UTXO"). No batching, queue, or parallel pools. Under concurrent load: (a) second buyer racing the first gets double-spend rejection, (b) 25+ unconfirmed buys chain together and hit the node's `too-long-mempool-chain` limit, blocking operator fee funding. The optimistic outpoint guard (stas-actions.ts:315-317) rejects stale advances but forces client-side retries.

**The maths is fine**: Linear curve cost = `k·delta·(2s+delta+1)/2` is exact integer arithmetic, no exp/ln, covenant-verifiable on-chain. Overflow-safe for realistic ranges (verified to 3×10^15, well under BigInt/SQLite limits). LMSR needed transcendental functions and couldn't verify on-chain; this can. The problem is **serialization**, not math.

**Mitigation**: Off-chain fills + batched settlement (proven in sibling prediction-market project). Buyer gets signed receipt instantly, operator batches every N orders into ONE on-chain pool advance with N outputs. Settlement size O(outputs), independent of fill count. Preserves capital efficiency (single reserve UTXO), unlimited throughput, users get instant quotes. Trade-off: covenant doesn't enforce each fill in real-time (operator signs receipt, auditable fraud proof). Alternative: serial queue + retry (simple, low throughput), batch-accepting covenant (complex unlock), or sharded pools (price incoherence).

**Cost**: Mainnet proven (STATE.md:62,95 — delivery failures after deep unconfirmed chains). Analysis in docs/CURVE-SERIALIZATION-ANALYSIS.md. Throughput ceiling ~10-25 buys per confirmation cycle without mitigation.

**Decision**: Defer curves entirely until post-instant-swap success (instant swap has zero serialization issues, each sale is independent). If curves demanded later, implement off-chain batch settlement first.


## The UI can be right about the money and still lie to the user (2026-08-27, ADR-030 UI pass)

A manual mainnet pass of the trustless curve completed the full lifecycle — deploy `4cdd07f3`,
buy 40 `1157fe43`, sell 20 `b92919f7`, sell-out `441c2462`, graduate `f74ee5b2`. Every satoshi was
correct when the transactions were downloaded and checked. Four things were still wrong, and none of
them would have shown up in a headless test:

- **The buy quote said 820 sats; the wallet asked for 1,143.** The difference is our `feeSats` (300)
  plus the wallet's own fee to create the funding output (~23). The number was never wrong, it was
  just *incomplete* — and a price that changes when the wallet opens destroys trust instantly. The
  card now shows "820 to the curve + ~300 network fee = ~1,120".
- **A sold-out pool rendered its status as "scheduled".** The pill was reading the stale `Sale` row
  instead of the pool state that the rest of the card had just resolved from chain.
- **"Your tokens — no settled orders to register" was shown to someone holding 60 tokens.** The
  claim card is for wallet-held STAS; a trustless-curve holding is a ledger entry inside the
  covenant. Technically accurate, completely misleading. Hidden for that variant.
- **"you hold" silently read 0 until the wallet prompt returned**, because the balance is keyed to a
  derived key we cannot know before asking. Now renders "—" until identified.

**And one honest gap the pass exposed rather than a bug:** after graduation the holder still had 60
in the final ledger, and **nothing mints it**. ADR-027/030 always specified that real STAS is minted
to holders from the final ledger after graduation, but that step is not built. Selling back before
graduation is currently the only way to realise value. The card now says so plainly instead of
showing a cheerful "Graduated".

> The takeaway: headless e2e proves the money moves correctly. It cannot tell you the interface is
> describing a different transaction than the one the wallet is about to sign. Both are needed.

**Deploy costs more than the seed suggests.** The wallet builds the deploy transaction itself and
priced it at 0.10 sat/B — 1,207 sats for the 12 KB output — so a "546 sat" pool actually cost 1,753.
Our own calibrated 0.01 rate only applies to transactions we assemble.


## A freshly-broadcast transaction is not immediately readable (2026-08-27, graduation mint)

The graduation mint worked on the first try (issuance `a70f7be3`, a correct 1,439-byte STAS output
for 60 tokens). Delivery then failed with **`could not read the token output`** — and the mint was
fine. WhatsOnChain indexes a broadcast transaction a few seconds later, and the UI enabled
**Deliver** the instant the mint broadcast, with no wait at all. Re-running the same read path a
minute later returned everything cleanly.

Two failures in one:
- **No propagation wait between a write and the read that depends on it.** Delivery now retries for
  ~24 s before giving up.
- **The error named the symptom, not the cause.** "Could not read the token output" is true and
  useless; it now says the issuance is not visible on chain yet and to try again shortly.

> Any step that reads back something we just broadcast needs a retry, and its failure message should
> name propagation explicitly — otherwise a transient race reads as a broken mint, which is exactly
> the wrong thing for a user to conclude about money they have just spent.

Also: `issueStasGenesis` prompts the wallet **once**, not twice — CONTRACT and ISSUE are built in a
single action. My walkthrough said twice, which had the user watching for a prompt that never comes.


## A delivery recorded under the wrong identity is invisible to the person it is for (2026-08-27)

The graduation mint delivered correctly on mainnet (`19b510826b9d` — a 1,439-byte STAS output for
60 tokens at the holder's pkh). The holder still could not claim it, and the reason was not on
chain at all.

`getClaimables` finds a buyer's tokens by **`buyerIdentity`**. A graduation delivery is run by the
PROJECT, so the Order carried the project's identity, not the holder's — and we never learn a
holder's identity key in the first place. A trustless-curve balance is keyed to a **derived pkh**,
which is all we ever see. So every holder who was not also the project owner would have seen
nothing, forever, while their tokens sat correctly on chain in an address they control.

It looked fine in testing only because the owner and the holder were the same wallet.

> **When the party who performs an action is not the party it is for, an identity-keyed lookup is
> wrong by construction.** Key the record to something the recipient can independently derive — here
> the pkh their wallet re-derives on demand — and test with the two parties distinct.

The related mistake was mine too: I had hidden the claim card entirely for this variant, on the
grounds that a pre-graduation holding is a ledger entry and not wallet STAS. True before
graduation, wrong after it — a binary hide where the answer was conditional. There is now a
dedicated card that looks up by pkh and, before the project mints, says so plainly instead of
reporting "no settled orders" to someone owed 60 tokens.


## Two identities for one user is a bug generator (2026-08-27, ADR-030)

Graduated tokens were delivered correctly on chain (`19b51082`, a 1,439-byte STAS output at the
holder's pkh) and never appeared in the wallet's assets. The user asked the right question: *"might
it be that it was sent to my wallet address but not to my wallet's STAS address?"* — and that was
exactly it.

The trustless curve had given every user **two** derived keys per sale:

| purpose | derivation |
|---|---|
| ledger holder identity (signs sells) | `counterparty: 'anyone', forSelf: true` |
| STAS token address (everywhere else in the app) | `counterparty: 'self'` |

Different derivations, different pubkeys, different addresses. The graduation mint delivered to the
LEDGER key, because that is who the ledger says is owed — which conflated **who is owed** with
**where their tokens should land**. The tokens sat in an address the wallet controlled but did not
surface.

The `'anyone' + forSelf` choice was inherited from `LedgerTradeCard`, where it was picked only to
make `getPublicKey` and `createSignature` agree for the covenant's `checkSig`. It was never a
deliberate decision to give holders a second identity; it just propagated.

**Fixed by unifying on `'self'`** — the derivation the rest of the app already uses — so a ledger
balance and a token balance live under one key. `MerkleClaimTokens` still derives the legacy key so
tokens already delivered there can be swept to the right address, and says so in the UI rather than
silently doing an extra transaction.

> When a key is chosen to satisfy a *signing* constraint, check what else that key becomes the
> identity for. Here it silently became the delivery address, and the failure surfaced three phases
> later as "my tokens aren't showing".

**Still to verify:** the covenant sell signature under `'self'`. The Option B STAS transfer already
pairs `getPublicKey`/`createSignature` this way, so it should hold — but it is a money-critical path
and has not yet been driven on mainnet with the new derivation.


## A stale working tree can silently revert merged work (2026-08-27)

Right after merging two PRs and pulling `main`, the working tree was **older than both branches** —
`stas-actions.ts` was 847 lines against main's 929, missing `sweepPendingStasDeliveries` entirely
and re-introducing a graduated-status bug that had already been fixed. Twenty-plus files I had not
touched showed as modified, all of them reversions.

It surfaced only because a build failed on a *different* feature branch with
`has no exported member named 'sweepPendingStasDeliveries'` — an error about code that was
demonstrably committed on `main`. Had that branch not touched the web app, the next commit would
have quietly reverted a week of merged work.

> **When `git status` shows files you did not touch, stop and diff them against the branch before
> committing anything.** `git diff main -- <file>` and a line count told the whole story in seconds.
> The tell was the direction: the tree was *removing* code rather than adding it.

Recovery was: copy the genuinely-new untracked files aside, `git reset --hard main` (untracked files
survive it), then re-apply the intended edits onto the correct versions. Re-applying by hand rather
than resolving a diff mattered — the earlier edits had been made against stale files, so "keeping"
them would have preserved the reversion.

## A cited "eviction threshold" that was really a floor-hit (2026-08-27)

Lowering Option B's fee rate, I hit a comment warning that 0.011 sat/byte was "the mempool eviction
threshold that was killing the underpaid covenant txs" — and I had just set 0.01, below it. I
stopped and went to the original finding.

It was not a threshold. The 2026-08-04 bug sized every output at a flat 34 bytes, ignoring the
~3.5 KB covenant script, so a ~7 KB transaction paid the **40-sat `MIN_FEE` floor**. "0.011 sat/byte"
is simply 40 ÷ 3,683 — the arithmetic *result* of hitting that floor, never a rate anyone chose or
tested. The real fix (size from actual bytes) was correct and is still in place; the rate beside it
was picked conservatively and never measured.

> A number that appears in a post-mortem is not automatically a measurement. Check whether it was
> *chosen* or *observed*, and whether anyone tested the thing it is now being used to justify.

Corrected the comment in both places rather than leave a false threshold for the next person.

**And the measurement that settled it was not the probe.** Padded OP_RETURN probes at the right size
said 0.0011 sat/B was mineable, but those are standalone transactions with confirmed parents. What
actually decided it was six REAL covenant spends from earlier mainnet runs — a sell at 0.0099, buys
at 0.0122, graduations at 0.0163 — all sitting on 51-64 confirmations. Purpose-built probes tell you
what the network accepts; your own transaction history tells you what it does with the shape you
actually broadcast.

## A mainnet verification run that only printed its txids (2026-08-28)

Three Option B transactions were still unconfirmed hours after a round-trip, so I flagged them for
follow-up. Coming back to check them the next day, **I could not find the txids anywhere.** Not in
`prisma/dev.db` (the run was a `packages/curve/service` script, not the app, so no `Order` row was
written), not in a log, not in any file the run touched. They existed only as stdout, and stdout only
survived because the session transcript happened to still be on disk. I recovered them by grepping
`~/.claude/projects/.../<session>.jsonl`.

The follow-up was worth doing — all three had confirmed in block 964189, which upgraded the fee claim
from "the mempool accepted it" to "a miner mined it at 0.0101 sat/B". That is the difference between a
plausible rate and a proven one, and it nearly went unverified because the evidence was ephemeral.

> A mainnet run spends real money and produces the only proof that it worked. If the txid lives only in
> stdout, the proof expires with the scrollback.

Two things follow:

- **Verification scripts should append their txids to a file**, not just print them. A one-line JSONL
  record per broadcast (`{txid, purpose, size, feeSats, broadcastAt}`) is enough, and it costs nothing.
- **Recovering them exposed two WhatsOnChain traps**, both now in `~/.claude/bsv-field-notes.md`
  because they are not ours: `/tx/hash/{txid}` returns `vin[].value` as `0`, so a fee computed from the
  summary comes out negative; and `/address/{addr}/history` silently caps at 100 entries, so a
  transaction that is genuinely there reads as absent.
