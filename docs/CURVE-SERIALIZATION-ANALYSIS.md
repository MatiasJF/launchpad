# Bonding Curve Serialization Analysis

**Date**: 2026-08-24
**Question**: Does our bonding curve hit the same wall the sibling prediction-market project hit with LMSR, and if so how do we mitigate it before building further?

---

## Executive Summary

**YES, it hits the same wall.** The linear bonding curve shares LMSR's serialization problem while avoiding its math problem. The covenant math is script-verifiable (no exp/ln needed), but every buy spends the same single UTXO with no batching, queue, or concurrent handling. This creates a throughput ceiling and user-visible failures under moderate load.

**Recommendation for MVP (instant swap first, curves later)**: Defer curves entirely until post-instant-swap success, then implement **Option 1** (off-chain fills + batched settlement). This matches the prediction market's proven mitigation, preserves capital efficiency, and unblocks the instant-swap product immediately.

---

## Claim Verification

### **A. THE MATHS IS FINE** ✅ VERIFIED

**Claim**: Linear curve cost = `k·delta·(2s+delta+1)/2` is a closed-form integer sum needing no exp, no ln, no loop. The covenant can verify `newReserve >= reserveBefore + cost` ON-CHAIN.

**Verification**:

- **Source**: `packages/curve/src/contracts/linearCurvePool.ts:19`
  ```typescript
  //     cost = k · delta · (2s + delta + 1) / 2
  //
  // One of `delta` and `(2s+delta+1)` is always even, so the /2 is EXACT — no lossy
  // division on the enforce path.
  ```

- **Covenant enforcement**: `linearCurvePool.ts:56`
  ```typescript
  const cost: bigint = (this.k * delta * (2n * s + delta + 1n)) / 2n;
  // ...
  assert(newReserve >= reserveBefore + cost, 'underpaid for delta tokens');
  ```

- **Parity proof**: One of `delta` or `(2s+delta+1)` is always even:
  - If `delta` is even: `delta = 2n` → divisible by 2
  - If `delta` is odd: `2s+delta+1 = 2s+(odd)+1 = 2s+even = even` → divisible by 2
  - Therefore `/2` is always exact integer division, never lossy.

- **Comparison to LMSR**: The prediction market needed `exp(buy_delta) / (1 + sum(exp(shares)))` which requires transcendental functions impossible in Script. This curve uses pure arithmetic.

**Arithmetic bounds check**:

| Parameter | Reasonable Max | Expression | Max Value | Overflow Risk |
|-----------|----------------|------------|-----------|---------------|
| k | 1000 sats | - | 1000 | None |
| supply | 1,000,000 tokens | - | 1,000,000 | None |
| s (sold) | 1,000,000 | - | 1,000,000 | None |
| delta | 1,000,000 | - | 1,000,000 | None |
| 2s | 1,000,000 | 2 × 1,000,000 | 2,000,000 | None |
| 2s + delta + 1 | 1,000,000 | 2,000,000 + 1,000,000 + 1 | 3,000,001 | None |
| k × delta | 1000 × 1,000,000 | 1,000 × 1,000,000 | 1,000,000,000 | None |
| k × delta × (2s+delta+1) | - | 10^9 × 3×10^6 | **3×10^15** | **None** (JS safe) |

- **Script limits**: Bitcoin Script bigints are variable-length. The covenant uses scrypt-ts which compiles to Script OP codes. No fixed-width overflow.
- **TypeScript assembly**: `BigInt` in `stasBuyAssembly.ts:100` and `stas-actions.ts:32` are arbitrary-precision.
- **Database**: Prisma schema uses `BigInt` for `reserveSats`, `sold`, `k`, `supply` (schema.prisma:107-111). SQLite `INTEGER` is 8-byte signed (-2^63 to 2^63-1 = ±9×10^18). Our max 3×10^15 fits comfortably.

**Conclusion**: The math is genuinely in the easy case. No overflow anywhere in realistic ranges.

---

### **B. THE SERIALIZATION IS NOT** ❌ CONFIRMED

**Claim**: `linearCurvePool.ts:14` says "a single evolving UTXO" and every buy spends it to create a successor. No batching, queue, or concurrency handling exists.

**Verification**:

**1. Single UTXO architecture confirmed**:
- `linearCurvePool.ts:13-14`: "A single evolving UTXO: its satoshi balance IS the reserve; its script carries `sold`"
- `buyAssembly.ts:155`: Output 0 is the successor pool; covenant self-replicates
- `stas-actions.ts:298-347`: `recordStasBuy` advances the pool UTXO atomically

**2. No batching found**:
- **Searched** for: queue, batch, concurrent, parallel in curve assembly files
- **Found**: `batchTransferStas` exists in `settle/batch.ts` for STAS token delivery ONLY, not curve buys
- **Pool updates**: Single tx per buy, no aggregation

**3. Concurrency handling**:
- **Only mechanism**: Optimistic outpoint guard in `stas-actions.ts:315-317`
  ```typescript
  if (pool.poolTxid !== input.spentPoolTxid || pool.poolVout !== input.spentPoolVout) {
    return { ok: false, error: 'pool has moved — this buy raced another; rebuild against the latest outpoint' };
  }
  ```
- **How it works**: Buyer builds against outpoint `A:0`, broadcasts, calls record. If another buy landed first (`A:0` → `B:0`), this buyer gets rejected and must rebuild against `B:0`.

**Scenario analysis**:

#### **Two buyers submit at the same moment:**

**What happens**:
1. Both call `prepareStasBuy` → both get outpoint `A:0`, `sold=10`, `cost=5 sats`
2. Both build TX-A spending `A:0` → `B:0` (buyer 1) and `A:0` → `C:0` (buyer 2)
3. First to broadcast to the node wins
4. Second broadcast: node returns `258: txn-mempool-conflict` (field notes confirmed)
5. Loser's `recordStasBuy` fails the outpoint guard: `pool has moved — rebuild against the latest outpoint`

**Error user sees**:
- **Where**: Client-side after broadcast attempt OR server-side in `recordStasBuy`
- **Message**: `"258: txn-mempool-conflict"` (from node) or `"pool has moved — this buy raced another; rebuild against the latest outpoint"` (from optimistic guard)
- **File:line**: Broadcast error in browser console / `stas-actions.ts:316`

**Cost**: Buyer wasted gas on TX1 payment funding (their wallet built it), must retry from scratch.

#### **Twenty-five buyers submit in a row with nothing confirming:**

**What happens**:
1. Buy 1 broadcasts: `A:0` → `B:0` (unconfirmed)
2. Buy 2 prepares against `B:0` → `C:0` (unconfirmed), broadcasts
3. Buy 3 prepares against `C:0` → `D:0`...
4. Buy 25 broadcasts: `Y:0` → `Z:0`
5. Buy 26 prepares: calls `prepareStasBuy`, gets pool state `Z:0`
6. Builds TX-A with pool input `Z:0` (which has 25 unconfirmed ancestors)
7. **Operator fee funding** calls `selectOperatorFeeInputs`
8. **Depth check** (operatorBaseFunding.ts:119-180):
   ```typescript
   fetchUnconfirmedDepth?: (txid: string) => Promise<number | null>;
   maxUnconfirmedDepth?: number; // default 10
   ```
9. Pool UTXO `Z:0` has `unconfirmedAncestorCount = 25` (> 10)
10. **All base UTXOs also deep** (operator change chains through the same path)
11. Selection returns: `{ ok: false, reason: "all N operator base UTXO(s) have deep unconfirmed ancestry — wait for confirmation or fund from fresh source to avoid too-long-mempool-chain" }`

**Error user sees**:
- **Where**: Server-side in `deliverStasToBuyer` (after buyer paid!)
- **Message**: `"all N operator base UTXO(s) have deep unconfirmed ancestry — wait for confirmation..."`
- **File:line**: `operatorBaseFunding.ts:180` (selection failure), surfaced by `stas-actions.ts:409` (`deliverStasToBuyer`)
- **State**: Buyer's order stuck `pending` (paid but not delivered)

**Recovery**: Operator must wait for confirmation OR fund base from a fresh confirmed UTXO. Buyer paid, tokens eventually delivered, but stuck in limbo. **Already hit on mainnet** (STATE.md:62,95).

#### **A buyer's quote is built from pool state that advances before their tx relays:**

**What happens**:
1. Buyer calls `prepareStasBuy` at T+0ms → pool at `sold=10`, outpoint `A:0`
2. Client builds TX-A locally (takes 500ms for wallet signing)
3. At T+300ms, another buyer's TX lands: pool advances to `B:0`, `sold=11`
4. At T+500ms, original buyer broadcasts TX-A spending `A:0`
5. Node returns `258: txn-mempool-conflict` (A:0 already spent)
6. Buyer's `recordStasBuy` call fails optimistic guard: `pool has moved`

**Error user sees**:
- **Where**: Broadcast failure (browser) OR `recordStasBuy` rejection (server)
- **Message**: `"258: txn-mempool-conflict"` or `"pool has moved — this buy raced another; rebuild against the latest outpoint"`
- **File:line**: Broadcast error OR `stas-actions.ts:316`

**Cost**: Buyer must refresh + retry. Their TX1 payment funding may have broadcast (wasted gas).

---

### **C. THE INEQUALITY** ⚠️ BUYER OVERPAY ABSORBED, NOT LOST

**Claim**: The covenant checks `newReserve >= reserveBefore + cost`. Who receives an overpayment, and can a buyer lose satoshis by paying more than cost?

**Verification**:

**Covenant enforcement**: `linearCurvePool.ts:61`
```typescript
assert(newReserve >= reserveBefore + cost, 'underpaid for delta tokens');
```

**Overpayment handling**:

1. **Buyer pays**: `stasBuyAssembly.ts:133`
   ```typescript
   const payNeeded = cost + fee;
   const funding = await createTokenFundingOutput({ wallet, chain, satoshis: payNeeded, ... });
   ```
   Buyer funds exactly `cost + fee`. No change output in TX-A (stasBuyAssembly.ts:152 has ONE output: the successor pool).

2. **Fee consumption**: The buyer's payment input is `payNeeded` sats. Output 0 (pool) gets `reserveBefore + cost`. The difference (`fee`) goes to miners.

3. **If buyer overpays** (pays `cost + 100` instead of `cost + fee`):
   - Pool receives `reserveBefore + cost + (overpay − fee)` if output 0 value is set to the full payment
   - **Actual behavior** (stasBuyAssembly.ts:152): Output 0 value is EXACTLY `newReserve = reserveBefore + cost`. The overpayment goes to miners (larger fee).
   - Covenant ALLOWS `newReserve >= reserveBefore + cost`, so a larger reserve would pass. But the assembly code sets `newReserve = reserveBefore + cost` exactly.

4. **Where overpayment goes**:
   - If buyer's payment input is `1000` and pool output is `950` (cost), fee is `50`. If buyer input was `1050`, fee becomes `100`. **Miners take it**.
   - Buyer CANNOT lose sats to the pool beyond `cost` because `newReserve` is client-calculated.
   - Buyer CAN lose sats to miners if they overfund TX1.

**Explicit change**: `stasBuyAssembly.ts:152` — TX-A has NO buyer change output. The covenant pins output 0 via ANYONECANPAY|SINGLE; buyer's SIGHASH_ALL commits the whole tx. No room for a second output.

**Conclusion**: Overpayment is absorbed by miners (larger fee), not by the pool reserve or the buyer's pocket. The inequality `>=` is covenant-level flexibility; the assembly always funds exactly `cost`.

---

## Mitigation Design

### **Mempool Depth Bounds**

**Current bound**: Operator base funding enforces `maxUnconfirmedDepth = 10` (operatorBaseFunding.ts:123).

**Node limit**: `too-long-mempool-chain` error triggers at 25 ancestors (field notes + STATE.md:62,95 confirmed on mainnet).

**What bounds depth today**:
- Operator funding **skips** base UTXOs with `unconfirmedAncestorCount > 10` (operatorBaseFunding.ts:151-177)
- If ALL base UTXOs are deep, selection **fails before build** with explicit error
- Buy can land, but delivery stalls until confirmation

**What SHOULD bound it**:
- **Ideal**: Never build beyond the node's 25-ancestor limit
- **Current**: Soft guard at 10 prevents most failures but doesn't eliminate them (if operator base is exclusively funded from the trade path, all paths accumulate depth together)
- **Fix needed**: Separate confirmed funding source for the operator base, OR wait-for-confirmation between batches

---

### **Mitigation Options**

Comparing four approaches with cost, complexity, and trade-offs:

| Option | Capital Efficiency | Throughput | Complexity | User Experience | What You Give Up |
|--------|-------------------|------------|------------|-----------------|------------------|
| **1. Off-chain fills + batched settlement** | ⭐⭐⭐⭐ (single reserve UTXO) | ⭐⭐⭐⭐⭐ (unlimited) | ⭐⭐⭐ (moderate) | ⭐⭐⭐⭐⭐ (instant) | Covenant real-time enforcement (trust operator for fills) |
| **2. Serial queue + retry** | ⭐⭐⭐⭐ (single UTXO) | ⭐ (low) | ⭐⭐⭐⭐⭐ (simple) | ⭐⭐ (retries visible) | Throughput under load |
| **3. Batch-accepting covenant** | ⭐⭐⭐⭐ (single UTXO) | ⭐⭐⭐⭐ (high) | ⭐ (recompile) | ⭐⭐⭐⭐ (fewer retries) | Covenant simplicity (complex unlock) |
| **4. Sharded parallel pools** | ⭐⭐ (N reserves) | ⭐⭐⭐⭐⭐ (scales with N) | ⭐⭐⭐ (routing logic) | ⭐⭐⭐ (price incoherence) | Single price (shards drift apart) |

---

#### **Option 1: Off-chain execution + batched settlement**

**How it works** (prediction market proven):
1. Buyer requests buy(delta) → operator quotes `cost` + signs a RECEIPT (`{buyer, delta, cost, sig, timestamp}`)
2. Receipt is a promise to deliver; stored in DB as `Order(state=filled, paymentTxid=null)`
3. Buyer pays `cost` sats to operator's address (separate tx, not the pool)
4. Periodically (every N orders OR every T minutes), operator builds ONE on-chain settlement:
   - `[pool input] → [successor pool @ newReserve, receipt_1 @ delta_1, receipt_2 @ delta_2, ...]`
   - Settlement size is O(outputs), independent of fill count
   - Pool advances by `Σdelta` in ONE tx
5. Users hold receipts until settlement confirms, then internalize SPV proof

**Cost**:
- **Dev time**: Moderate (signed receipts, batch assembly, settlement reconciliation)
- **Capital**: Single reserve UTXO (no sharding waste)
- **Gas**: One tx per batch vs N txs per fill (10× - 100× savings)

**Complexity**: Moderate. Need receipt schema, periodic batch job, settlement tx assembly.

**What it gives up**:
- **Real-time covenant enforcement**: Pool doesn't verify each fill on-chain. Operator can misquote, but signature commits them (auditable fraud proof).
- **Immediate SPV**: Users get receipts instantly, SPV proof after batch settles.

**Precedent**: The prediction market used exactly this (fills off-chain against signed receipts, one on-chain advance per batch). Proven on mainnet.

---

#### **Option 2: Keep per-trade on-chain, add serializing queue + retry**

**How it works**:
1. Buy requests enter a FIFO queue (Redis / DB)
2. Worker pops one, builds TX-A, broadcasts, records
3. If `pool has moved` (outpoint guard fails), worker retries against fresh pool state
4. Next buy starts AFTER prior buy records (strict serial)

**Cost**:
- **Dev time**: Low (queue + worker)
- **Capital**: Single UTXO
- **Gas**: N txs for N fills (same as now)
- **Throughput**: ~1 buy per block time (10 min), or faster if unconfirmed chaining allowed (then hits mempool depth limit at 25)

**Complexity**: Simple.

**What it gives up**:
- **Throughput**: Serial processing, no parallelism. Under load, queue grows.
- **UX**: Users see "waiting for prior buy to complete" delays.

**Verdict**: Simplest, but lowest throughput. Fine for a demo with <10 concurrent users. Breaks under moderate load.

---

#### **Option 3: Covenant that accepts a batch of deltas in one transaction**

**How it works**:
1. Recompile `LinearCurvePool.buy` to accept `delta[]` array
2. Single tx: `[pool input, buyer_1 input, buyer_2 input, ...] → [successor pool, receipt_1, receipt_2, ...]`
3. Covenant verifies `newReserve >= reserveBefore + Σcost(delta_i)`
4. Each buyer signs their own input (no trust aggregator)

**Cost**:
- **Dev time**: High (covenant rewrite, scrypt-ts array handling, multi-buyer assembly)
- **Capital**: Single UTXO
- **Gas**: One tx per batch (like Option 1)
- **Throughput**: High (batch size limited by tx size, ~1000 outputs)

**Complexity**: Low to moderate (covenant complexity, multi-party signing coordination).

**What it gives up**:
- **Covenant simplicity**: Array iteration in Script, larger unlock
- **Atomic coordination**: Need all buyers to sign simultaneously (vs Option 1's async fills)

**Verdict**: Technically possible, but requires covenant recompilation + complex unlock. Harder than Option 1 for similar throughput.

---

#### **Option 4: Sharded parallel pools**

**How it works**:
1. Deploy N independent pool covenants (shard 0, shard 1, ..., shard N-1)
2. Route buyer to shard `hash(buyerIdentity) % N`
3. Each shard processes buys independently in parallel

**Cost**:
- **Dev time**: Moderate (routing, shard selection, cross-shard price reconciliation)
- **Capital**: N × reserve (fragmented liquidity)
- **Gas**: N txs for N fills (same as now, but parallel)
- **Throughput**: N × serial throughput

**Complexity**: Moderate (routing, state sync across shards).

**What it gives up**:
- **Price coherence**: Shards drift apart. Shard 0 at `sold=10` while shard 1 at `sold=50` → different prices for the same token.
- **Capital efficiency**: Reserve split across N shards, each needs minimum seed.

**Verdict**: Scales throughput but fragments the market. Only viable if price incoherence is acceptable (it's not for a bonding curve).

---

## Recommendation

### **For the MVP (instant swap first, curves later):**

**DO NOT BUILD CURVES YET.** The instant swap product has zero serialization issues (each sale is an independent UTXO, no shared pool). Deliver that first, prove demand, gather user feedback.

**If curves are demanded post-MVP, implement Option 1** (off-chain fills + batched settlement):

**Why**:
1. **Proven**: Prediction market ran this on mainnet successfully
2. **Capital efficient**: Single reserve UTXO (no sharding waste)
3. **Throughput**: Unlimited fills, settlement size O(outputs) not O(fills)
4. **User experience**: Instant quotes, batched settlement invisible to user
5. **Complexity**: Moderate (lower than Option 3, more robust than Option 2)

**Implementation path**:
1. Buyer calls `prepareStasBuy` → operator returns `{delta, cost, receiptSig}`
2. Receipt = `sign(operatorKey, sha256({buyerIdentity, delta, cost, timestamp}))`
3. Buyer pays `cost` sats to operator's separate address (not the pool), gets receipt stored as `Order(state=filled)`
4. Operator batches every 10 orders OR every 5 minutes (whichever first)
5. Batch tx: `[pool input, operator base input] → [successor pool @ reserveBefore + Σcost, receipt_1 output, receipt_2 output, ...]`
6. Pool advances by `Σdelta` in one tx; buyers internalize SPV proofs

**What breaks if we ship the curve without this**:
- **25 concurrent buys**: 26th buyer's delivery fails (operator base too deep), order stuck `pending`
- **2 simultaneous buys**: One gets `txn-mempool-conflict`, wasted gas, must retry
- **Throughput ceiling**: ~10-25 buys per confirmation cycle (limited by mempool depth)
- **User confusion**: Unpredictable "pool has moved" errors, retry loops

**Risk ranking** (by what loses money or blocks users):

1. **CRITICAL**: Mempool depth failure leaves buyers paid but undelivered (delivery stalls) — **user loses access to capital until operator fixes**
2. **HIGH**: Concurrent buy conflicts waste gas on failed funding txs — **user loses sats to miners for nothing**
3. **MEDIUM**: Throughput ceiling blocks scale — **platform can't grow beyond 25 concurrent users**
4. **LOW**: Retry loops degrade UX — **annoying but not lossy**

---

## Conclusion

The linear bonding curve **does hit the same serialization wall as LMSR**, despite solving LMSR's math problem. The single-UTXO architecture creates unavoidable concurrency bottlenecks and mempool depth failures under moderate load.

**For the scoped MVP (instant swap only)**, this is moot — curves are deferred. Ship instant swap, prove demand, then decide if curves are worth the mitigation complexity. If yes, implement Option 1 (off-chain fills + batched settlement) following the prediction market's proven path.
