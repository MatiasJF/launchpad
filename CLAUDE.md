# BSV Launchpad — Claude Boot File

**Read this first.** With no context, read in order:
this file → `docs/STATE.md` → `docs/INDEX.md`. Three files and you are productive.

**Before BSV work, also read `~/.claude/bsv-field-notes.md`** — verified chain, SDK and toolchain behaviour
learned by hitting it on mainnet in a sibling project: WhatsOnChain reporting spent outputs as unspent,
BRC-29 derivation direction, the `@bsv/wallet-toolbox` `dotenv` override, BEEF ancestry depth, and the
Node/pnpm/tsx traps that each cost an hour. It is kept outside any repository so every BSV project shares it.

**And `docs/LESSONS.md`** for what has gone wrong *here*. When something surprises you — a symptom that
pointed at the wrong cause, a tool behaving differently than documented, a test that passed while wrong,
money moving unexpectedly — add it, via the `/lesson` skill. Chain- or toolchain-level findings that would
help any BSV project go in the field notes instead, so they outlive this repo.

## What this is

A token launchpad native to the BSV Blockchain. Projects issue STAS tokens and
sell them to the public; buyers connect a BRC-100 wallet (BSV Desktop) and buy
on mainnet. The MVP is a single fixed-price "instant swap": pay sats, receive
tokens, verify on-chain. Everything else (escrow presales, staking, curves,
farms) is a future layer on top of that spine.

## How it works

Hybrid, operator-settled. Issuance, holdings, and settlement are real on-chain
STAS UTXOs — independently SPV-verifiable. The pricing / matching / sequencing
engine is our backend. We publish enough on-chain that a buyer can verify they
got what they paid for. BSV has no global mutable state, so the operator
sequences buys to avoid UTXO contention.

## Golden rules

1. **The KB is part of every change (Definition of Done).** No task is done
   until: STATE.md reflects it · INDEX.md updated if files moved · DECISIONS.md
   appended if a choice was made · SCHEMA.md / ARCHITECTURE.md synced if the
   model or structure moved.
2. **Mainnet always — real sats, permanent records.** No testnet fallback.
   Label demo tokens clearly; never issue anything mistakable for a live project
   outside the admin gate.
3. **Never handle wallet secrets.** No private keys, seed phrases, mnemonics —
   ever. Users sign in their own wallet. If a secret appears, stop and warn.
4. **Keep the app a thin shell.** Business rules live in `packages/core` and
   `packages/bsv`, not in Next.js routes.
5. **Decisions are logged, not remembered.** Worth keeping? Append DECISIONS.md.
6. **Commits are plain — no trailers.** Never add `Co-Authored-By` or
   `Claude-Session` lines to commit messages.
7. **Build through orchestration.** Run substantive build work via the
   `/orchestrator:orchestrate` skill — decompose, fan out, verify — not ad-hoc
   solo edits. Trivial one-liners may stay solo.

## Stack

TypeScript · Next.js (App Router) · pnpm workspace · SQLite via Prisma
(→ Postgres later) · BSV TS SDK for STAS / settlement / SPV · BRC-100 wallet
(BSV Desktop).

## Scope right now

- **In:** admin-gated project creation · STAS issuance on mainnet · fixed-price
  public buy · on-chain settlement + SPV.
- **Out:** fees · legal/KYC process (admin approval stands in) · escrow
  presales · staking · bonding curves · farms · vaults.

## The map

- `docs/STATE.md` — current status: done / in progress / next _(living)_
- `docs/INDEX.md` — where-is-what: topic → file _(living)_
- `docs/DECISIONS.md` — why it's this way (ADR log) _(append-only)_
- `docs/ARCHITECTURE.md` — how it's built
- `docs/SCHEMA.md` — the data model
- `docs/ROADMAP.md` — phases & status
- `docs/GLOSSARY.md` — STAS, UTXO, BRC-100, escrow, SPV, covenant…
- `docs/artifacts/` — the visual planning docs (roadmap, deep-dive, vision map,
  foundation, KB preview)
