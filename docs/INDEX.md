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
- Curve serialization analysis (single-UTXO throughput, mitigation options) → `docs/CURVE-SERIALIZATION-ANALYSIS.md`
- Launch guide (all sale types, procedures, troubleshooting) → `docs/LAUNCH-GUIDE.md`
- Decentralized funding strategy (on-chain enforcement map, trustless crowdfunding + curve, phased roadmap) → `docs/research/decentralized-funding-strategy.md`
- Research: UTXO concurrency / serialization patterns → `docs/research/UTXO-CONCURRENCY-PATTERNS.md`
- Research: comparable decentralized crowdfunding protocols (Eth/Cosmos/Cardano) → `docs/research/task-6-decentralized-crowdfunding-protocols.md`
- Operator key custody (HSM/KMS signer for production; contract + provider recipes) → `docs/OPERATOR-KEY-CUSTODY.md`
- Covenant audit prep — Option B / ADR-028-029, the SHIPPED operator-gated curve (audit surface, invariants 1-8, drain vectors) → `docs/COVENANT-AUDIT-PREP.md`
- Covenant audit prep — ADR-030 trustless Merkle-ledger curve (NO operator key; invariants 1-12, drain vectors 1-7, accepted design properties incl. zero spread + 65,536-holder ceiling, and our own testing gaps) → `docs/AUDIT-PREP-MERKLE-LEDGER.md`
- External review brief for the ADR-030 covenant (8pp, BSVA-branded, 3 diagrams) — hand this to an outside reviewer; regenerate from `docs/research/covenant-brief-assets/` → `docs/research/BSVA-Covenant-Review-Brief.docx`
- Covering note to send with the review brief (email body: the ask, what is out of scope, what we want back) → `docs/research/covenant-brief-assets/covering-note.md`
- Trustless bonding-curve protocol roadmap (ledger track; scaling limits, SMT mandate, open client) → `docs/TRUSTLESS-LEDGER-ROADMAP.md`

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
- Fetch on-chain output script / balance / ancestry BEEF → `apps/web/lib/settle-actions.ts` (`getOutputScriptHex`, `getOutputInfo`, `getSourceBeef`, `getSourceBeefDeep` — unconfirmed-safe ancestry BEEF: walks raw ancestry, anchors at confirmed merkle bumps, fail-closed; used by delivery so a fresh/just-moved vault no longer blocks TX-B)
- Chained-transfer BEEF (spend a prior transfer's token change) → `StasSource.beef` from-chain; basket path in `settle/beef.ts` is fallback only
- Browser polyfills for bsv-js → `apps/web/next.config.mjs` (webpack fallbacks)
- STAS knowledge (external) → `stas-knowledge-mcp` MCP (local) + `../stas-knowledge-mcp/knowledge`
- Escrow-presale pledges (ADR-025) → `packages/bsv/src/pledge/` (`createPledge` 0xC1 · `assembleAssuranceTx` · `withdrawPledge` + `PLEDGE_BASKET`, ADR-033)
- Pledge server actions → `apps/web/lib/escrow-actions.ts` (`recordPledge` with on-chain + signature validation · `reconcileWithdrawnPledges` · `getMyPledges` · `markPledgeWithdrawn` · `getPledgesForAssembly` · `markAssemblyBroadcast`)
- Escrow presale mainnet round-trip → `apps/web/scripts/e2e-presale.mjs` (`pnpm --filter @launchpad/web e2e:presale`; `--deliver=<saleId>` resumes delivery once the vault confirms)
- Mainnet run txid ledgers → `docs/mainnet-runs/*.jsonl` (one record per broadcast, so a run's proof outlives the scrollback)

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
- Operator flat-key FEE funding (ADR-028 revised — replaces `@bsv/wallet-toolbox` on the trade path) → `packages/bsv/src/settle/operatorBaseFunding.ts` = `@launchpad/bsv/settle/base-funding` (`selectOperatorFeeInputs` = pick base P2PKH UTXO(s) covering a fee, ancestry-anchored; `buildOperatorFundingTx` = flat-key split TX1 minting an exact-fee output for the sell refund; `signOperatorP2pkhInput` = P2PKH input sign via a `signFeeDigest` callback; `p2pkhScriptHexForPkh`). Key stays callback-only; WoC I/O injected. App-side WoC callbacks: `getOperatorBaseUtxos` (WoC confirmed+unconfirmed base UTXOs, mempool-spent dropped) + `broadcastBeefChain` (parents-first multi-pass flush of an atomic BEEF's unconfirmed chain) in `apps/web/lib/settle-actions.ts`
- Operator STAS delivery TX-B (operator-key-signed token input + operator BASE-address flat-key fee input(s), BOTH via `operatorSignDigest` callback — NO toolbox; ONE tx `[token, base fee] → [recipient, (token-change), BSV-change to base]`, both ancestries merged into the atomic BEEF) → `packages/bsv/src/settle/operatorDeliver.ts` (`operatorDeliverStas`)
- Stas curve SELL assembly (Step 3, ADR-028) · TX2 reserve refund = [pool SELL input 0xc1 + operator cosign + '51' selector, flat-key operator fee input 0x41 consumed whole] → [reserve successor, seller refund] (2 outputs — the covenant pins exactly these; the atomic 3-output sell is infeasible, see DECISIONS ADR-028 step-3). Fee input comes from a flat-key `buildOperatorFundingTx` split (TX1, exact-fee output + change back to base — no toolbox); output-1 = the seller's recorded address at the curve refund (payee NOT covenant-bound = accepted operator-trust) → `packages/curve/src/stasSellAssembly.ts` (`buildStasSellRefundTx`); runtime sell-unlock encoder `packages/curve/src/curvePool.ts` (`encodeSellUnlockingHex`, byte-proven vs compiled ABI); offline sell + FIX-2 tests in `packages/curve/service/verify-stas.ts`
- STAS full-provenance back-to-genesis (FIX 2 — every same-tail input must reach genuine issuance; amount-conserved; DAG-memoised, node-bounded, fail-closed; pure + unit-tested) → `packages/curve/src/provenance.ts` (`provenanceWalk`, `isStasScript`, `stasTail`, `stasOwnerPkh`); WoC-wired in `apps/web/lib/settle-actions.ts` (`verifyStasBackToGenesis`, `findStasOutputToPkh`, `fetchTxIO`)
- Stas curve SELL server actions (Step 3; TX1 STAS return + unique-outpoint replay guard, TX2 operator-funded + operator cosign, full-provenance B2G + unspent recheck before refund, mirror recordCurveBuy guard) → `apps/web/lib/stas-actions.ts` (`prepareStasSell`, `recordStasSell`, `finalizeStasSell`)
- curve_sell double-refund replay guard (FIX 1) → `Order.sellReturnOutpoint` @unique + migration `packages/db/prisma/migrations/20260731140000_order_sell_return_outpoint/` · proof `packages/db/test/sell-replay-guard.test.mjs` (`pnpm --filter @launchpad/db test`)
- Stas curve UI (Step 4, ADR-028) → owner deploy+mint `apps/web/components/StasPoolManage.tsx` (configurable small k/supply) · buyer+seller trade card `apps/web/components/StasTradeCard.tsx` (buy = TX-A + operator deliver; sell = client STAS-return TX1 + operator refund TX2) · sale-page conditional `app/sale/[slug]/page.tsx` (`variant==='stas'` → `StasTradeCard`) · manage wiring `components/ProjectManage.tsx`
- Stas curve deploy config + seller holdings (Step 4) → `apps/web/lib/stas-actions.ts` (`createStasPool` now takes `k`/`supply`; `prepareStasSell` returns `vaultAddress`; `getSellerStasDeliveries`)
- On-chain pool discovery (ADR-030; the genesis tx is self-describing, so no DB is needed to read a pool) → `packages/curve/src/poolAnnounce.ts` (`encodePoolAnnouncement`/`decodePoolAnnouncement`/`findAnnouncement`; 44-byte `OP_FALSE OP_RETURN 'BSVLP' 'mlp1' <k> <supply> <payoutPkh> [<ticker>]`) · `resolveMerklePoolFromGenesis(genesisTxid)` in `service/resolveMerkleLedgerPool.ts` — reads terms from the announcement then REBUILDS the genesis script and requires a byte-match, so an unsigned announcement cannot lie · emitted as deploy output 1 by `createMerklePool`/`MerklePoolManage` (covenant stays output 0) · tests `packages/curve/test/pool-announce.test.mjs`
- Graduation mint (ADR-030; final ledger → wallet-held STAS — the ONE step the covenant cannot enforce) → actions in `apps/web/lib/merkle-ledger-actions.ts` (`getMerkleFinalLedger` — recomputes the mint list from the genesis tx alone, callable by anyone so a holder can prove their own claim; `prepareMerkleMint`/`recordMerkleMint`/`recordMerkleDelivery` — owner-gated, delivery idempotent per holder via a `curve_graduation_mint` Order) · UI `apps/web/components/MerkleGraduationMint.tsx` (mints to the owner's OWN key, no operator vault; states the trust boundary in a warning panel). Atomic mint-at-graduation is infeasible — STAS single-change rule, see ADR-029
- ADR-030 UI (trustless curve, owner + trader) → owner deploy `apps/web/components/MerklePoolManage.tsx` (one signed step; payout fixed at deploy) · buyer/holder `apps/web/components/MerkleTradeCard.tsx` (keyless buy, holder-signed sell via the per-sale derived key — protocolID STAS + keyID slug + counterparty 'anyone' + forSelf, the same derivation for getPublicKey AND createSignature or checkSig fails; permissionless graduate offered to anyone once sold out; dust-floor warning; contention translated to "the price moved") · reuses the covenant-agnostic `buildLedgerBuyTx`/`buildLedgerSellTx`/`buildLedgerGraduateTx` · manage-page variant CHOICE + sale-page `variant === 'merkle'` wiring in `components/ProjectManage.tsx` / `app/sale/[slug]/page.tsx`
- ADR-030 app wiring (the app reads pool state from CHAIN, not the DB) → CLI actions `packages/curve/service/cli.ts` (`merkle-genesis`, `merkle-resolve`, `merkle-buy`, `merkle-sell-digest`, `merkle-sell-unlock`, `merkle-graduate`) · child-process bridge `apps/web/lib/merkle-ledger-service.ts` · server actions `apps/web/lib/merkle-ledger-actions.ts` (`createMerklePool`, `markMerklePoolDeployed` — re-resolves against chain before trusting, `getMerklePool` — chain-derived, `prepareMerkleBuy`, `prepareMerkleSell` — returns `feeInputSats` because the sell fee input is consumed WHOLE, `finalizeMerkleSell`, `prepareMerkleGraduate` — NOT owner-gated by design, `recordMerkleTrade`/`recordMerkleGraduate` — receipts only) · DB `genesisTxid`/`genesisVout` (migration `curve_pool_genesis_outpoint`; kept separate from the tip-tracking `poolTxid`) · mainnet e2e `apps/web/scripts/e2e-merkle-app.mjs` (`pnpm --filter @launchpad/web e2e:merkle`, 33/33)
- Chain-truth helpers for mainnet harnesses (verify unspent; download txs and assert on REAL size/fee/outputs) → `packages/curve/service/wocInspect.ts` (`verifiedUnspent` — /spent-checked, reports the stale total; `inspectTx`/`reportTx` — real size, fee from parent lookups, effective sat/B, confirmations)
- Spread decision model + fee-rate calibration (ADR-031 — why the curve carries NO spread, and why the fee FLOOR is the real constraint) → `packages/curve/service/model-spread.ts` (round-trip cost vs trade size, spread break-even, revenue projection, truncation-safety and split-to-dodge analysis) · `packages/curve/service/calibrate-fee-rate.ts` (`--probe` broadcasts pool-SIZED txs at descending rates, `--check` reports which were actually MINED — acceptance into a mempool is NOT the answer, an accepted-but-unmined tx jams every successor)
- ADR-030 chain reconstruction + open client (DB-free; the bounded-size pool as a protocol target) → parser `packages/curve/src/merkleLedgerReconstruct.ts` (`parseMerkleOp`, `reconstructMerkleHistory` — recovers ownerPkh + SLOT INDEX + isNew; buy 39 chunks/`OP_0` path@1 siblings@17 isNew@33 delta@35, sell 40/`OP_1` path@3 amount@36, graduate 2/`OP_2`) · slot-exact replay `src/merkleLedger.ts` (`replayMerkleSlots`) and `service/merkleLedgerState.ts` (`normalizeOps`, `toSlotOps`, `poolScriptForSlotOps` — chain histories replay by RECORDED slot, never re-derived) · resolver `service/resolveMerkleLedgerPool.ts` (`resolveMerkleLedgerPool`) · client `service/merkleLedgerClient.ts` (`MerkleLedgerPoolClient` — same API as `LedgerPoolClient`, incl. `submitBuy`/`submitSell` contention loop) · chain proof `service/verify-merkle-resolve.ts` (16/16 against mainnet pool `4c6faf97…:0`, read-only/no sats)
- Bounded-size Merkle ledger covenant (ADR-030 — replaces the O(holders) HashedMap ledger; script is constant in holder count) → sCrypt `packages/curve/src/contracts/merkleLedgerPool.ts` (32-byte root + holderCount; buy appends at `holderCount` proving the slot EMPTY, or updates proving the slot's CURRENT (owner,balance); sell is holder-signed; graduate terminal) · off-chain tree `packages/curve/src/merkleLedger.ts` (`MerkleLedger`, `leafHash`, `rootFromProof`, `replayMerkle`, DEPTH=16) · state service `packages/curve/service/merkleLedgerState.ts` (construct-at-genesis-then-MUTATE, never the constructor form — else the successor won't byte-match) · tests `packages/curve/test/merkle-ledger.test.mjs` (14) · offline interpreter proof `service/verify-merkle-pool.ts` (16/16) · mainnet lifecycle `service/verify-merkle-mainnet.ts` (6/6, pool `4c6faf97…:0`) · the measurement behind the ADR `service/measure-ledger-size.ts`
- Test-wallet consolidation (harnesses fund a run from a SINGLE input; a fragmented wallet fails "no verified-unspent UTXO > N" while holding plenty) → `packages/curve/service/consolidate-test-wallet.ts` (`--dry` supported; verifies each candidate against `/spent` first)
- Permissionless graduation (ADR-027 phase 5a; terminal — anyone releases the reserve to the payout fixed at deploy, no signature) → `packages/curve/service/ledgerClient.ts` (`buildGraduate` — guards `sold == supply` + already-graduated, and lets the graduator take change since ANYONECANPAY|SINGLE pins only output 0) · `resolveLedgerPool` confirms a graduation really pays the committed payout the full reserve before reporting `graduated` (an unparseable spend is an error, not a false "sale completed") · mainnet proof `packages/curve/service/verify-graduation-mainnet.ts` (a STRANGER key with no tokens/role graduates; asserts payout got the full reserve, graduator net-negative, no third destination, ledger survives the pool UTXO; pool `75f84209…:0` → graduation `82e5dd53…`)
- Permissionless sequencing / contention recovery (ADR-027 phase 4; "loser re-signs" — no operator sequencer for the single hot pool UTXO) → `packages/curve/service/ledgerClient.ts` (`submitBuy`, `submitSell`, private `submit` bounded retry loop, `isOutpointConflict` — distinguishes a race from a genuinely invalid spend so real bugs aren't masked; returns `attempts` + `repriced` because a rebuilt trade is re-priced at the NEW curve position) · mainnet contention proof `packages/curve/service/verify-sequencing-mainnet.ts` (real conflicting broadcasts → real `258: txn-mempool-conflict` → recovery; buy race + sell race asserting one fresh signature per attempt; pool `31820de7…:0`)
- Open client library for the trustless ledger pool (ADR-027 phase 3; the "anyone builds a UI" boundary — no server actions, no DB, no operator, never sees a key) → `packages/curve/service/ledgerClient.ts` (`LedgerPoolClient` — `genesisScript`, `state`, `quoteBuy`/`quoteSell`/`quoteSellFee`, `balanceOf`, `buildBuy` keyless, `buildSell` holder-signed, `buildGraduate`, `broadcast`; wallet plugs in via an @bsv/sdk `UnlockingScriptTemplate` + a `Holder` that signs one digest; every build re-resolves from chain + interpreter-checks the bytes) · mainnet acceptance test `packages/curve/service/verify-open-client-mainnet.ts` (open→read→buy→re-read→sell→rebuild→guards; `--resolve <genesisTxid> [supply]` reads any pool; reference pool `84e72674…:0`, k=1 supply=60). NOTE: a sell's fee input is consumed whole (0xc1 pins 2 outputs → no change), so pre-size it via `quoteSellFee()`
- DB-free ledger pool resolution (ADR-027 phase 2; live outpoint + reserve + sold + holder balances from WhatsOnChain alone) → `packages/curve/service/resolveLedgerPool.ts` (`resolveLedgerPool(genesisTxid, {k, supply, payoutPkh})`, `balancesFrom`; self-verifying walk — each hop byte-matches the recomputed successor; `tipRechecks` guards WoC's mempool spent-index lag, where a 404 can mean "spend not indexed yet" and yields a stale tip) · mainnet proof `packages/curve/service/verify-reconstruct-mainnet.ts` (`--dry` builds+interpreter-checks; `--resolve <genesisTxid>` re-verifies from chain only; reference pool genesis `3e247404…:0`, k=1, supply=100)
- Trustless ledger reconstruction (ADR-027; DB-free — the trustless linchpin) → parser `packages/curve/src/ledgerReconstruct.ts` (`parseLedgerOp`, `reconstructHistoryFromUnlocks`, `reconstructLedgerHistory`) rebuilds the op history from on-chain input-0 unlock scripts (buy `OP_0`/delta@3, sell `OP_1`/amount@4, graduate `OP_2`), fed to `packages/curve/service/ledgerState.ts` (`replay`, `poolScriptForHistory` — proven byte-exact vs mainnet successors); offline proof `packages/curve/service/verify-reconstruct.ts` (17/17: reconstructed lockingScript byte-matches the successor tip, direct + genesis→tip walk) · roadmap `docs/TRUSTLESS-LEDGER-ROADMAP.md` phase 1
- Stuck-refund recovery (Step 3b; sell whose refund failed mid-flow — STAS returned, no `refundTxid`) → `apps/web/lib/stas-actions.ts` (`getPendingStasSells`, `completePendingStasSell` — seller-scoped guard, delegates to idempotent `finalizeStasSell`) · UI notice + "Complete refund" button in `apps/web/components/StasTradeCard.tsx` (Sell tab)
- Stuck-delivery recovery (Step 2b; buy whose delivery failed mid-flow — paid, `curve_buy` pending, no delivery `txid`) → `apps/web/lib/stas-actions.ts` (`getPendingStasDeliveries`, `completePendingStasDelivery` — buyer-scoped guard, delegates to idempotent `deliverStasToBuyer`) · UI notice + "Complete delivery" button in `apps/web/components/StasTradeCard.tsx` (Buy tab)
- Offline BEEF-assembly check (unconfirmed tip anchored by a confirmed merkle bump → valid, atomic-resolvable BEEF; validates the `getSourceBeefDeep` strategy) → `packages/curve/test/deep-beef.test.mjs`
- Operator key (co-sign gate + STAS/sats vault, flat-key base address `1D86…`, pkh `84f96c45…`) → `apps/web/lib/operator-wallet.ts` (`getOperator`, `operatorSignDigest`) · `getOperatorWallet`/`operatorBalance` + toolbox `apps/web/lib/operator-toolbox.ts` are `@deprecated` (OFF the trade path — see `settle/base-funding`; kept only for the harness's non-operator wallet roles)
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

| **What has gone wrong before (read before building)** | `docs/LESSONS.md` |
| **Cross-project BSV chain/SDK/toolchain facts** | `~/.claude/bsv-field-notes.md` |
| **Capturing a new lesson** | `.claude/skills/lesson/SKILL.md` (`/lesson`) |
