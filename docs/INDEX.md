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
- STAS transfer (settlement) → `packages/bsv/src/settle` (`transferStas` + `twoTx/` primitives + `beef.ts` first-pass — BSV-003)
- Settle-token UI (client, wallet transfer) → `apps/web/components/SettleButton.tsx`
- Fetch on-chain output script / balance / ancestry BEEF → `apps/web/lib/settle-actions.ts` (`getOutputScriptHex`, `getOutputInfo`, `getSourceBeef`)
- Chained-transfer BEEF (spend a prior transfer's token change) → `StasSource.beef` from-chain; basket path in `settle/beef.ts` is fallback only
- Browser polyfills for bsv-js → `apps/web/next.config.mjs` (webpack fallbacks)
- STAS knowledge (external) → `stas-knowledge-mcp` MCP (local) + `../stas-knowledge-mcp/knowledge`

## App

- Landing + explore → `apps/web/app/page.tsx` · `apps/web/components/ExploreSection.tsx`
- Project / sale detail → `apps/web/app/sale/[slug]/page.tsx`
- Roles / identity model (platform · project · buyer) → `docs/DECISIONS.md` ADR-023
- Shared wallet connection (connect once, app-wide) → `apps/web/components/WalletProvider.tsx` (`useWallet`) + `getWalletClient()` in `packages/bsv/src/wallet`
- Project submission (wallet-connected, sets owner + payout) → `apps/web/components/SubmitForm.tsx` + `createProject` in `apps/web/lib/actions.ts`
- Identity helpers (pubkey check · Account upsert · owner gate) → `apps/web/lib/identity.ts`, `apps/web/lib/account-actions.ts`
- Project owner dashboard (issue + settle, owner-gated) → `apps/web/app/project/[slug]/manage/page.tsx` + `apps/web/components/ProjectManage.tsx`
- On-chain payment verification (buyer paid the payout) → `apps/web/lib/settle-actions.ts` (`verifyPaymentToAddress`)
- Buy card (buyer flow: derive receive addr, reserve → pay → confirm) → `apps/web/components/BuyCard.tsx`
- Order server actions (reserve / confirm-payment / claim-settle / release / mark-settled / buyer-claimables) → `apps/web/lib/order-actions.ts`
- Settle-order UI (admin, delivers tokens; auto-resolves pool) → `apps/web/components/SettleOrderButton.tsx`
- Pool auto-resolution + spent-guard + broadcast → `apps/web/lib/settle-actions.ts` (`resolveCurrentPool`, `isOutputUnspent`, `broadcastRawTx`)
- STAS receive-register (buyer internalizes delivered tokens) → `packages/bsv/src/receive` (`receiveStasToken`)
- Bonding-curve AMM covenant (Phase 0 spike; ADR-026) → `packages/curve` — sCrypt source `src/contracts/counter.ts`, compiled hex `artifacts/`, `@bsv/sdk` spend/verify `src/covenant.ts`, offline proof `test/`, isolated compile `scripts/compile.sh`, notes `README.md`
- Buyer claim UI (register settled purchases into wallet) → `apps/web/components/ClaimTokens.tsx` (on sale page)
- Safe markdown renderer (project descriptions) → `apps/web/components/Markdown.tsx` + `.md` styles in `globals.css`
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
