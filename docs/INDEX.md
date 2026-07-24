# Index — Where Is What

Topic → location. Entries marked _(planned)_ don't exist yet; they name where
the thing WILL live so the map is stable from day one. _(stub)_ = placeholder
present, not implemented.

## Knowledge & decisions

- Project overview & rules → `CLAUDE.md`
- Current status → `docs/STATE.md`
- Why a thing is the way it is → `docs/DECISIONS.md`
- Terminology → `docs/GLOSSARY.md`
- How it's built → `docs/ARCHITECTURE.md`
- Data model → `docs/SCHEMA.md`
- Phases & status → `docs/ROADMAP.md`
- Visual planning docs → `docs/artifacts/`

## Domain & data

- Entity types & enums (Account, Project, Token, Sale, Order, Event)
  → `packages/core/src/entities`
- Sale state machine (instant | escrow) → `packages/core/src/sale` _(stub)_
- Prisma schema → `packages/db/prisma/schema.prisma`
- Prisma client export → `packages/db/src/index.ts`

## BSV / on-chain

- STAS issuance → `packages/bsv/src/issue` _(stub)_
- Settlement (build/broadcast/ARC) → `packages/bsv/src/settle` _(stub)_
- SPV verification → `packages/bsv/src/spv` _(stub)_
- BRC-100 wallet connection → `packages/bsv/src/wallet` _(stub)_

## App

- Public browse & project pages → `apps/web/app/(public)` _(planned)_
- Buy flow → `apps/web/app/(public)/sale` _(planned)_
- Admin: create / approve → `apps/web/app/(admin)` _(planned)_
- Backend API (sequence/settle) → `apps/web/app/api` _(planned)_

## Design

- Design system & tokens → `docs/DESIGN.md` _(planned, P1)_
- UI pattern reference → Mobbin · `api.mobbin.com/mcp` _(MCP connected)_
