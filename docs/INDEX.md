# Index — Where Is What

Topic → location. Entries marked _(planned)_ don't exist yet; they name where
the thing WILL live so the map is stable from day one. _(stub)_ = placeholder
present, not implemented.

## Knowledge & decisions

- Project overview & rules → `CLAUDE.md`
- Current status → `docs/STATE.md`
- Why a thing is the way it is → `docs/DECISIONS.md`
- External references & candidate directions → `docs/REFERENCES.md`
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
- Prisma client (singleton) → `packages/db/src/index.ts`
- Seed script → `packages/db/prisma/seed.ts`
- DB reads → view models → `apps/web/lib/data.ts` (listSales, getSaleVMBySlug)
- View-model types → `apps/web/lib/types.ts`
- Server actions (submit / approve / admin login) → `apps/web/lib/actions.ts`
- Admin gate → `apps/web/lib/auth.ts`

## BSV / on-chain

- STAS issuance → `packages/bsv/src/issue` _(stub)_
- Settlement (build/broadcast/ARC) → `packages/bsv/src/settle` _(stub)_
- SPV verification → `packages/bsv/src/spv` _(stub)_
- BRC-100 wallet connection → `packages/bsv/src/wallet` (WalletClient) · UI `apps/web/components/WalletButton.tsx`
- STAS mint construction → `packages/bsv/src/issue` (`planMint`, server-only; ADR-021)
- Mint plan + record (server actions) → `apps/web/lib/mint.ts` (`buildMintPlan`, `recordIssuance`)
- Issue-token UI (client, wallet createAction) → `apps/web/components/IssueButton.tsx`
- STAS libs kept server-external → `apps/web/next.config.mjs`
- STAS transfer (settlement) → `packages/bsv/src/settle` (`transferStas` + `twoTx/` primitives, ported; `beef.ts` stub — BSV-003)
- STAS knowledge (external) → `stas-knowledge-mcp` MCP (local) + `../stas-knowledge-mcp/knowledge`

## App

- Landing + explore → `apps/web/app/page.tsx` · `apps/web/components/ExploreSection.tsx`
- Project / sale detail → `apps/web/app/sale/[slug]/page.tsx`
- Buy card (UI) → `apps/web/components/BuyCard.tsx`
- Submit a project → `apps/web/app/submit/page.tsx`
- Admin approval → `apps/web/app/admin/page.tsx`
- Backend API (sequence/settle) → `apps/web/app/api` _(planned)_

## Design

- Design system & tokens → `docs/DESIGN.md`
- Tailwind v4 theme + tokens → `apps/web/app/globals.css` · `apps/web/postcss.config.mjs`
- UI primitives → `apps/web/components/ui` (Button, Card, StatTile, StatusPill, Countdown, TokenomicsBar, icons)
- Page components → `apps/web/components` (SiteHeader, SiteFooter, ProjectCard, ExploreSection, BuyCard, WalletButton)
- Seed card data → `apps/web/lib/seed.ts` (getSaleBySlug)
- UI pattern reference → Mobbin · `api.mobbin.com/mcp` _(MCP connected)_
