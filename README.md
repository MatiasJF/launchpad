# BSV Launchpad

A token launchpad native to the BSV Blockchain. Projects issue STAS tokens and
sell them to the public; buyers connect a BRC-100 wallet (BSV Desktop) and buy
on mainnet.

> **New here? Read [`CLAUDE.md`](./CLAUDE.md) first**, then
> [`docs/STATE.md`](./docs/STATE.md) and [`docs/INDEX.md`](./docs/INDEX.md).
> The knowledge base in `docs/` is the source of truth for how the project is
> built, how it's going, and where everything lives.

## Stack

TypeScript · Next.js (App Router) · pnpm workspace · SQLite via Prisma.

## Layout

```
apps/web        Next.js: public launchpad + admin routes (thin shell)
packages/core   domain: entities, sale logic
packages/bsv    on-chain: STAS issuance, settlement, SPV, BRC-100 wallet
packages/db     Prisma schema + client (SQLite)
docs/           the knowledge base
```

## Develop

```bash
pnpm install          # install workspace deps
pnpm db:generate      # generate the Prisma client
pnpm db:migrate       # create / apply the SQLite migration
pnpm dev              # run the web app
```

## Conventions

- The knowledge base is updated as part of every change (see `CLAUDE.md`).
- Commit messages are plain — no co-author or session trailers.
- Substantive build work runs through `/orchestrator:orchestrate`.
