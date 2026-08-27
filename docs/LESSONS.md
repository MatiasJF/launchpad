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
