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
- Covenant live mainnet bench (deploy + increment, non-custodial) → `packages/curve/src/spike.ts` (`deployCovenant`, `buildIncrementTx`) · UI `apps/web/components/CovenantSpike.tsx` · page `apps/web/app/admin/covenant/page.tsx` (admin-gated)
- Linear bonding-curve reserve covenant (Phase 1; ADR-026) → sCrypt `packages/curve/src/contracts/linearCurvePool.ts` · @bsv/sdk buy spend+verify `packages/curve/src/curvePool.ts` (`curveCost`, `buildBuySpend`, `validateBuy`) · fixtures `artifacts/curve-locks.json` · tests `test/curve-pool.test.mjs`
- Runtime pool successor-script derivation (scrypt-ts-free, fixture-proven) → `packages/curve/src/curvePool.ts` (`poolScriptForSold`, `poolCodePart`, `encodeBuyUnlockingHex`) · tests `test/curve-script.test.mjs`
- Non-custodial curve buy assembly (pool input + buyer payment input signed ALL → successor pool + receipt) → `packages/curve/src/buyAssembly.ts` (`buildCurveBuyTx`, `deployCurvePool`, `CURVE_PARAMS`); mirrors `settle/batch.ts` two-tx pattern
- Curve server actions (pool create/deploy/state + operator-sequenced record-buy) → `apps/web/lib/curve-actions.ts` (`createCurvePool`, `markCurvePoolDeployed`, `getCurvePoolState`, `recordCurveBuy`)
- Stas curve (Option B, ADR-028) reserve covenant → sCrypt `packages/curve/src/contracts/stasCurvePool.ts` · genesis-script helper `packages/curve/service/stasState.ts` (`stasGenesisScript`) via CLI action `stas-genesis` (`packages/curve/service/cli.ts`) · offline tests `packages/curve/service/verify-stas.ts`
- Stas curve service bridge (child-process → CLI `stas-genesis`, scrypt-ts kept out of Next) → `apps/web/lib/stas-service.ts` (`stasGenesisScript(k, supply, operatorPkh)`)
- Stas curve server actions (deploy reserve covenant + mint STAS supply to operator vault, prepare/record split; Step 1) → `apps/web/lib/stas-actions.ts` (`createStasPool`, `markStasPoolDeployed`, `prepareStasMint`, `recordStasMint`, `getStasPool`)
- Stas curve BUY assembly (Step 2, ADR-028) · TX-A reserve buy = [pool BUY input 0xc3 + '00' selector, buyer payment input 0x41] → [reserve successor]; no receipt (delivery is TX-B); validates covenant input via @bsv/sdk → `packages/curve/src/stasBuyAssembly.ts` (`buildStasBuyTx`); offline TX-A test in `packages/curve/service/verify-stas.ts`
- Stas curve BUY server actions (Step 2; operator-sequenced against latest outpoint, mirror recordCurveBuy) → `apps/web/lib/stas-actions.ts` (`prepareStasBuy`, `recordStasBuy`, `deliverStasToBuyer`)
- Operator STAS delivery TX-B (operator-key-signed token input via callback + toolbox-signed fee input; mirrors `transferStas`) → `packages/bsv/src/settle/operatorDeliver.ts` (`operatorDeliverStas`)
- Stas curve SELL assembly (Step 3, ADR-028, hardened) · TX2 reserve refund = [pool SELL input 0xc1 + operator cosign + '51' selector, SELLER fee input 0x41 (payee lock)] → [reserve successor, seller refund] (2 outputs — the covenant pins exactly these; the atomic 3-output sell is infeasible, see DECISIONS ADR-028 step-3). SELLER builds+signs (`buildStasSellTx`), OPERATOR co-signs only the covenant input (`cosignStasSellTx`); `sellRefundMath`; validates covenant input via @bsv/sdk → `packages/curve/src/stasSellAssembly.ts`; runtime sell-unlock encoder `packages/curve/src/curvePool.ts` (`encodeSellUnlockingHex`, byte-proven vs compiled ABI); offline sell + FIX tests in `packages/curve/service/verify-stas.ts`
- STAS full-provenance back-to-genesis (FIX 2 — every same-tail input must reach genuine issuance; amount-conserved; DAG-memoised, node-bounded, fail-closed; pure + unit-tested) → `packages/curve/src/provenance.ts` (`provenanceWalk`, `isStasScript`, `stasTail`, `stasOwnerPkh`); WoC-wired in `apps/web/lib/settle-actions.ts` (`verifyStasBackToGenesis`, `findStasOutputToPkh`, `fetchTxIO`)
- Stas curve SELL server actions (Step 3; TX1 STAS return + unique-outpoint replay guard, TX2 seller-signed + operator cosign, full-provenance B2G + unspent check before refund, mirror recordCurveBuy guard) → `apps/web/lib/stas-actions.ts` (`prepareStasSell`, `recordStasSell`, `finalizeStasSell`)
- curve_sell double-refund replay guard (FIX 1) → `Order.sellReturnOutpoint` @unique + migration `packages/db/prisma/migrations/20260731140000_order_sell_return_outpoint/` · proof `packages/db/test/sell-replay-guard.test.mjs` (`pnpm --filter @launchpad/db test`)
- Operator key + custody wallet (co-sign gate + STAS/sats vault) → `apps/web/lib/operator-wallet.ts` (`getOperator`, `getOperatorWallet`, `operatorBalance`, `operatorSignDigest`) · toolbox `apps/web/lib/operator-toolbox.ts`
- Curve UI → buy card `apps/web/components/CurveBuyCard.tsx` · owner deploy `apps/web/components/CurvePoolDeploy.tsx` · sale-page wiring `app/sale/[slug]/page.tsx` · owner sets type in `components/ProjectManage.tsx` (Presale tab) via `updateSaleEscrow`
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
