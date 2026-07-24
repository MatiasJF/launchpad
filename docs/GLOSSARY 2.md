# Glossary

Shared vocabulary so terms mean one thing across the project.

- **STAS** — a BSV token protocol where each token amount lives inside a UTXO
  with a colored-coin script. Supply is minted at issuance; a transfer spends
  STAS UTXOs and re-creates them under the protocol rules.
- **UTXO** — Unspent Transaction Output; a discrete coin spent exactly once.
  BSV's model has no mutable account balances — only coins.
- **UTXO contention** — because a shared "pool" UTXO can be spent by only one
  party per step, features needing many concurrent writers serialize. The hybrid
  operator model sidesteps this by sequencing.
- **BRC-100** — the wallet-to-application interface standard. Our "connect
  wallet" layer; an interface protocol, not a token or DeFi standard.
- **BSV Desktop** — the first target BRC-100 wallet. Users sign their own txs
  in it (non-custodial).
- **Hybrid / operator-settled** — issuance, holdings, and settlement are real
  on-chain STAS UTXOs (SPV-verifiable); the pricing/matching/sequencing engine
  is our backend (ADR-001).
- **Instant swap** — the MVP sale: pay a fixed price, receive tokens now, verify
  on-chain. No pool, no finalize.
- **Escrow presale** — a future sale type: contribute to a pool, run to a
  soft/hard cap, then finalize (claim) or fail (refund). Enables emergency
  withdraw.
- **Emergency withdraw** — bailing out of an escrow pool mid-sale for a penalty;
  meaningful only under the escrow model, not instant swap.
- **Bonding curve** — price as a deterministic function of supply sold; the curve
  acts as the market maker. A stateful contract (must remember `sold`).
- **SPV** — Simplified Payment Verification; verifying a tx is in a block via a
  Merkle proof, without a full node.
- **ARC** — the BSV transaction broadcaster/processor used to submit txs.
- **Covenant** — an on-chain constraint (via sCrypt / Bitcoin Script) that
  enforces how a UTXO may be spent; the trustless end of the settlement spectrum.
- **Vesting** — releasing allocations over time via timelocked UTXOs
  (`nLockTime` / `CLTV`).
- **Overlay service** — an off-chain indexer (BRC-22/24) tracking the app's
  UTXO set and derived state.
