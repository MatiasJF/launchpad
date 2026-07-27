# References & candidate directions

External products/patterns worth capturing as things we *might* pursue. **Not
decisions** — see `DECISIONS.md` for what's committed and `docs/artifacts/` for
the roadmap/vision.

## pump.fun — bonding-curve launchpad with auto-graduation to an AMM

_Added 2026-07-27 (shared by the team). https://pump.fun · runs on Solana._

A public token launchpad whose defining idea is **automated, demand-driven
pricing** — it behaves like an automated exchange rather than a fixed-price sale:

1. **Instant public token creation** — anyone launches a token in a few clicks.
2. **Bonding-curve pricing (the core)** — buy/sell price is set *automatically*
   off a curve as a function of how much supply has sold; no counterparty or
   order book. The curve **is** the market maker. (We studied curve shapes in the
   Deep-Dive: linear / exponential / constant-product.)
3. **Auto-graduation to an internal swap/AMM** — once a token crosses a
   volume / market-cap threshold, its liquidity is automatically moved into an
   AMM pool and the bonding curve retires, so trading continues on a standard
   pool. Usually paired with anti-rug (liquidity locked/burned on graduation).

### How it maps to our plan

- It's essentially **L4 (bonding curve) + L5 (AMM / market-making)** from the
  Vision Map, fused and fully automated with an auto-graduation trigger.
- The pricing half aligns with the Deep-Dive's bonding-curve track:
  fixed price → operator-enforced curve → sCrypt covenant.

### The BSV / UTXO reality (why this is the hard tail)

- pump.fun runs on **Solana (account-based)**, where one mutable pool contract
  makes an automated curve + AMM + auto-graduation trivial.
- On **BSV UTXO** this is exactly the **single-UTXO-contention** problem we
  flagged (ADR-001, Vision Map): a curve/pool is one stateful UTXO spent-and-
  recreated per trade, which **serialises trades**. Realistic BSV path:
  operator-sequenced curve first → harden into an sCrypt covenant; auto-
  graduation becomes an operator/covenant action that moves the reserve into a
  pool primitive.

### Verdict

A compelling **north-star for the market-making layer**, but it sits squarely in
the **deferred hard tail**. Order of operations stays: offering engine + issuance
+ settlement first (where we are now), then revisit the automated-curve model
once a pool primitive exists. Specifics (exact graduation threshold, which DEX)
are Solana-specific and would be redesigned for BSV — verify before quoting.
