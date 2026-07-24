# Roadmap

Phases & status. The detailed visual version is in
`docs/artifacts/launchpad-foundation.html`; live task status is in
`docs/STATE.md`.

## P0 · Foundation & Knowledge Base — _in progress_

Scaffold the repo, the knowledge base, and the entity schema before any feature,
so the project is documentable from its first commit.
**Deliverable:** an empty but fully-documented project any Claude can pick up in
three reads.

## P1 · Wallet + read path

BRC-100 connect via BSV Desktop (identity + balance); public browse of projects
and project pages (read-only). Design system begins here, sourcing UI patterns
from Mobbin → `docs/DESIGN.md` (WEB-002).
**Deliverable:** connect a wallet and browse a seeded project on mainnet.

## P2 · Admin-gated issuance

Auth gate + admin approval; STAS issuance tx on mainnet; public allocation split
into sale-pool UTXOs.
**Deliverable:** a real token issued on mainnet behind admin auth.

## P3 · L0 instant swap — _MVP complete_

Fixed-price buy: user signs in their own wallet, operator sequences + settles;
ARC broadcast + SPV verify; `Order` + `Event` recorded.
**Deliverable:** the one honest loop — buy a project token on mainnet, end to end.

## P4+ · The layers _(future — see Vision Map)_

L1 project surface (dashboards, metrics, docs) · L2 escrow presale (soft/hard
cap, finalize, refunds, emergency withdraw) · L3 identity & allocation (tiers,
KYC) · L4 distribution (vesting UI, airdrops) · L5 rewards & market (staking →
bonding curves → farms → vaults).
