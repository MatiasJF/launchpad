'use server';

import { prisma } from '@launchpad/db';
import { Utils } from '@bsv/sdk';
import { isProjectOwner } from './account-actions';
import {
  merkleGenesisScript, resolveMerklePool, buildMerkleBuy, merkleSellDigest, merkleSellUnlock, merkleGraduate,
  type MerkleSlotOp,
} from './merkle-ledger-service';

/**
 * Server actions for the ADR-030 bounded-size Merkle-ledger pool.
 *
 * Deliberately much thinner than `ledger-actions.ts` (ADR-027), and the difference is the point of
 * the whole trustless track:
 *
 *  - **The database is NOT the ledger.** ADR-027 rebuilt pool state from recorded Orders, so the
 *    operator's DB was authoritative and a divergence from the chain was unrecoverable — a reset
 *    genuinely lost a live pool's parameters once. Here every read goes to
 *    `resolveMerklePool`, which walks the chain. The DB stores only the genesis outpoint and the
 *    immutable public terms, so the worst a bad row can do is point at the wrong pool.
 *  - **No "pool moved" guard is needed for correctness.** ADR-027 had to reject a spend built
 *    against a stale outpoint because its DB mirror would otherwise desync. Here the covenant
 *    rejects it, and the client re-resolves and retries ("loser re-signs"). The recorded Order is
 *    a receipt, not state.
 *  - **There is no operator key anywhere on this path.** Buys are keyless, sells are signed by the
 *    holder, graduation is permissionless.
 *
 * These actions are a CONVENIENCE. A third party can do all of it with `MerkleLedgerPoolClient` and
 * a genesis txid, which is exactly the property the track exists to deliver.
 */

const DUST = 546;

/** hash160 (hex) of a P2PKH address — the covenant's payout key. */
function addrToPkh(addr: string): string {
  const { data } = Utils.fromBase58Check(addr);
  return Buffer.from(data as number[]).toString('hex');
}
const p2pkhScriptHex = (pkh: string) => `76a914${pkh.toLowerCase()}88ac`;

const buyCost = (k: bigint, sold: bigint, delta: bigint) => (k * delta * (2n * sold + delta + 1n)) / 2n;
const sellRefund = (k: bigint, sold: bigint, amount: bigint) => {
  const ns = sold - amount;
  return (k * amount * (2n * ns + amount + 1n)) / 2n;
};

/** Owner-gated: register the pool and hand back the genesis script for the owner's wallet to deploy. */
export async function createMerklePool(input: {
  saleId: string; identityPubkey: string; k: string; supply: string; seedReserveSats: number;
}): Promise<{ ok: boolean; scriptHex?: string; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (!sale.token.project.payoutAddress) return { ok: false, error: 'set a project payout address first (the reserve graduates there, immutably)' };
    if (input.seedReserveSats < DUST) return { ok: false, error: `seed reserve must be at least ${DUST} sats` };
    const k = BigInt(input.k), supply = BigInt(input.supply);
    if (k <= 0n || supply <= 0n) return { ok: false, error: 'k and supply must be positive' };

    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing && existing.status === 'live') return { ok: false, error: 'pool already live' };

    const payoutPkh = addrToPkh(sale.token.project.payoutAddress);
    const { scriptHex } = await merkleGenesisScript({ k: input.k, supply: input.supply, payoutPkh });
    await prisma.curvePool.upsert({
      where: { saleId: input.saleId },
      create: { saleId: input.saleId, variant: 'merkle', k, supply, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), payoutPkh, status: 'draft' },
      update: { variant: 'merkle', k, supply, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), payoutPkh },
    });
    return { ok: true, scriptHex };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record the GENESIS outpoint once the owner's deploy broadcasts. This is the only thing the app
 * needs to remember about a pool — everything else is derivable from the chain — so it is written
 * once and never moved.
 */
export async function markMerklePoolDeployed(input: {
  saleId: string; identityPubkey: string; genesisTxid: string; genesisVout?: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(input.genesisTxid)) return { ok: false, error: 'invalid genesis txid' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId }, include: { sale: { include: { token: { include: { project: true } } } } } });
    if (!pool || pool.variant !== 'merkle') return { ok: false, error: 'no merkle pool for this sale' };
    if (!(await isProjectOwner(pool.sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (pool.genesisTxid) return { ok: false, error: 'pool already deployed' };

    // Confirm the outpoint really is this pool before trusting it — a wrong genesis is the one
    // piece of state that would make the pool unreadable, so verify against the chain now.
    const vout = input.genesisVout ?? 0;
    const state = await resolveMerklePool({ genesisTxid: input.genesisTxid, genesisVout: vout, k: pool.k.toString(), supply: pool.supply.toString(), payoutPkh: pool.payoutPkh! });
    if ('error' in state) return { ok: false, error: `that outpoint does not resolve as this pool: ${state.error}` };

    await prisma.curvePool.update({
      where: { saleId: input.saleId },
      data: { genesisTxid: input.genesisTxid, genesisVout: vout, status: 'live' },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface MerklePoolView {
  ok: true;
  /** live outpoint, resolved from chain (NOT from the database) */
  poolTxid: string; poolVout: number; scriptHex: string;
  reserveSats: number; sold: number; supply: string; k: string; payoutPkh: string;
  holderCount: number; graduated: boolean; rootHex: string;
  balances: { ownerPkh: string; amount: number }[];
  history: MerkleSlotOp[];
  genesisTxid: string; genesisVout: number;
}

/**
 * The pool as the CHAIN reports it. The database supplies only the genesis pointer and terms;
 * balances, reserve, `sold` and the live outpoint are all reconstructed.
 */
export async function getMerklePool(saleId: string): Promise<MerklePoolView | { ok: false; error: string }> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId } });
    if (!p || p.variant !== 'merkle') return { ok: false, error: 'no merkle pool for this sale' };
    if (!p.genesisTxid || !p.payoutPkh) return { ok: false, error: 'pool is not deployed yet' };

    const state = await resolveMerklePool({
      genesisTxid: p.genesisTxid, genesisVout: p.genesisVout ?? 0,
      k: p.k.toString(), supply: p.supply.toString(), payoutPkh: p.payoutPkh,
    });
    if ('error' in state) return { ok: false, error: state.error };

    return {
      ok: true,
      poolTxid: state.txid, poolVout: state.vout, scriptHex: state.scriptHex,
      reserveSats: state.reserveSats, sold: Number(state.sold), supply: p.supply.toString(),
      k: p.k.toString(), payoutPkh: p.payoutPkh,
      holderCount: state.holderCount, graduated: state.graduated, rootHex: state.rootHex,
      balances: Object.entries(state.balances).map(([ownerPkh, amount]) => ({ ownerPkh, amount: Number(amount) })),
      history: state.history,
      genesisTxid: p.genesisTxid, genesisVout: p.genesisVout ?? 0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** BUY: the pool-input unlock crediting `buyerPkh` by `delta`. Keyless — nobody signs the credit. */
export async function prepareMerkleBuy(input: { saleId: string; buyerPkh: string; delta: number }): Promise<
  | { ok: true; unlockingHex: string; sourceLockHex: string; nextLockingHex: string; cost: number; newReserve: number; poolTxid: string; poolVout: number; reserveBefore: number; sold: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getMerklePool(input.saleId);
    if (!('ok' in p) || !p.ok) return { ok: false, error: (p as { error: string }).error };
    if (p.graduated) return { ok: false, error: 'pool has graduated — buying is closed' };
    if (!Number.isInteger(input.delta) || input.delta <= 0) return { ok: false, error: 'delta must be a positive integer' };
    if (BigInt(p.sold) + BigInt(input.delta) > BigInt(p.supply)) return { ok: false, error: 'exceeds curve supply' };

    const cost = Number(buyCost(BigInt(p.k), BigInt(p.sold), BigInt(input.delta)));
    const newReserve = p.reserveSats + cost;
    const r = await buildMerkleBuy({
      k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history,
      ownerPkh: input.buyerPkh, delta: String(input.delta),
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, newReserve,
    });
    return { ok: true, unlockingHex: r.unlockingHex, sourceLockHex: r.sourceLockHex, nextLockingHex: r.nextLockingHex, cost, newReserve, poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, sold: p.sold };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fee rate in sat/byte — measured on mainnet, see ADR-031 and `service/calibrate-fee-rate.ts`. */
const FEE_RATE = 0.01;

/**
 * SELL step 1: the digest the HOLDER's own wallet signs. No operator co-signature exists here.
 *
 * Returns `feeInputSats`, and callers must honour it. The sell unlock is ANYONECANPAY|ALL and the
 * covenant pins EXACTLY two outputs (successor + payout), so no change output is possible and the
 * whole fee input becomes the miner fee. A caller that funds it with a round number simply burns
 * the difference — an early run of the e2e harness paid 3,000 sats for a 24,838-byte transaction
 * (0.12 sat/B, 12x the going rate) purely because this value was not exposed.
 */
export async function prepareMerkleSell(input: { saleId: string; sellerPkh: string; amount: number; payoutScriptHex?: string }): Promise<
  | { ok: true; digestHex: string; sourceLockHex: string; nextLockingHex: string; payoutScriptHex: string; refund: number; reserveAfter: number; poolTxid: string; poolVout: number; reserveBefore: number; feeInputSats: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getMerklePool(input.saleId);
    if (!('ok' in p) || !p.ok) return { ok: false, error: (p as { error: string }).error };
    if (p.graduated) return { ok: false, error: 'pool has graduated — the ledger is final' };
    const held = p.balances.find((b) => b.ownerPkh.toLowerCase() === input.sellerPkh.toLowerCase())?.amount ?? 0;
    if (input.amount <= 0 || input.amount > held) return { ok: false, error: `insufficient ledger balance (holding ${held})` };
    const refund = sellRefund(BigInt(p.k), BigInt(p.sold), BigInt(input.amount));
    if (refund < BigInt(DUST)) return { ok: false, error: `refund ${refund} is below the ${DUST}-sat dust floor — sell more at once` };

    const payoutScriptHex = input.payoutScriptHex ?? p2pkhScriptHex(input.sellerPkh);
    const r = await merkleSellDigest({
      k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history,
      ownerPkh: input.sellerPkh, amount: String(input.amount),
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, payoutScriptHex,
    });
    // the fee input is consumed WHOLE, so size it from the real transaction: the unlock carries a
    // preimage dominated by the current pool script, plus the successor script and the payout
    const estBytes = p.scriptHex.length / 2 + r.nextLockingHex.length / 2 + 900;
    const feeInputSats = Math.ceil(estBytes * FEE_RATE);
    return { ok: true, ...r, payoutScriptHex, refund: Number(r.refund), poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats, feeInputSats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** SELL step 2: build the pool-input unlock from the holder's own signature. */
export async function finalizeMerkleSell(input: {
  saleId: string; sellerPkh: string; ownerPubHex: string; amount: number; payoutScriptHex: string; sigDerHex: string;
}): Promise<{ ok: true; unlockingHex: string; sourceLockHex: string; nextLockingHex: string; refund: number; reserveAfter: number } | { ok: false; error: string }> {
  try {
    const p = await getMerklePool(input.saleId);
    if (!('ok' in p) || !p.ok) return { ok: false, error: (p as { error: string }).error };
    const r = await merkleSellUnlock({
      k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history,
      ownerPkh: input.sellerPkh, ownerPubHex: input.ownerPubHex, amount: String(input.amount),
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats,
      payoutScriptHex: input.payoutScriptHex, sigDerHex: input.sigDerHex,
    });
    return { ok: true, ...r, refund: Number(r.refund) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * GRADUATION: the terminal spend releasing the reserve to the payout fixed at deploy.
 * Deliberately NOT owner-gated — the covenant lets anyone trigger it and cannot be steered, so
 * gating it here would add a permission the protocol does not have.
 */
export async function prepareMerkleGraduate(input: { saleId: string }): Promise<
  | { ok: true; unlockingHex: string; sourceLockHex: string; payoutScriptHex: string; reserve: number; poolTxid: string; poolVout: number }
  | { ok: false; error: string }
> {
  try {
    const p = await getMerklePool(input.saleId);
    if (!('ok' in p) || !p.ok) return { ok: false, error: (p as { error: string }).error };
    if (p.graduated) return { ok: false, error: 'pool already graduated' };
    if (BigInt(p.sold) !== BigInt(p.supply)) return { ok: false, error: `curve not fully sold (${p.sold}/${p.supply})` };
    const r = await merkleGraduate({
      k: p.k, supply: p.supply, payoutPkh: p.payoutPkh, history: p.history,
      poolTxid: p.poolTxid, poolVout: p.poolVout, reserveBefore: p.reserveSats,
    });
    return { ok: true, ...r, reserve: p.reserveSats, poolTxid: p.poolTxid, poolVout: p.poolVout };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record a settled trade as a RECEIPT. Unlike ADR-027 this does not carry pool state: the chain
 * already has it, and `getMerklePool` reads it back. Failing to record loses a row in the activity
 * feed, not the ledger — which is the whole point.
 */
export async function recordMerkleTrade(input: {
  saleId: string; identity: string; ownerPkh: string; kind: 'curve_buy' | 'curve_sell';
  tokens: number; sats: number; txid: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.order.create({
      data: {
        saleId: input.saleId, buyerIdentity: input.identity, receiveAddress: input.ownerPkh,
        kind: input.kind, tokens: BigInt(Math.floor(input.tokens)), satsPaid: BigInt(Math.floor(input.sats)),
        state: 'settled', paymentTxid: input.txid, txid: input.txid,
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mark a pool graduated once the terminal spend is on chain (a cache update — the chain decides). */
export async function recordMerkleGraduate(input: { saleId: string; graduateTxid: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!p || p.variant !== 'merkle') return { ok: false, error: 'no merkle pool' };
    await prisma.curvePool.update({ where: { saleId: input.saleId }, data: { status: 'graduated' } });
    await prisma.sale.update({ where: { id: input.saleId }, data: { status: 'finalized' } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRADUATION MINT — turning final ledger balances into wallet-held STAS
//
// THE HONEST TRUST BOUNDARY. Everything before this point is enforced by the covenant: the price,
// the custody, the refund, and the fact that the reserve can only ever reach the payout address
// fixed at deploy. This step is NOT. Once the pool graduates the project holds the sats and the
// holders hold ledger entries, and nothing on-chain compels the project to mint. An atomic
// mint-at-graduation is infeasible for the same reason the atomic buy was — a STAS token input may
// carry only token outputs plus exactly one change output, so real tokens cannot ride the covenant
// spend (ADR-029).
//
// What DOES survive: the mint list is permanent and public. `getMerkleFinalLedger` recomputes who
// is owed what from the genesis transaction alone, forever, with no database and no cooperation
// from us or the project. A project that takes the reserve and never mints cannot hide it, and
// anyone can prove the debt. That is weaker than covenant enforcement and it is stated plainly in
// the UI rather than glossed over.
// ─────────────────────────────────────────────────────────────────────────────

export interface FinalLedgerEntry { ownerPkh: string; amount: number; deliveredTxid: string | null }

/**
 * The mint list for a GRADUATED pool, recomputed from chain: who is owed how much, and what has
 * already been delivered. Callable by anyone — a holder should be able to verify their own claim
 * without asking the project.
 */
export async function getMerkleFinalLedger(saleId: string): Promise<
  | { ok: true; graduated: boolean; total: number; entries: FinalLedgerEntry[]; issuanceTxid: string | null; tokenId: string | null; genesisTxid: string }
  | { ok: false; error: string }
> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId }, include: { sale: { include: { token: true } } } });
    if (!p || p.variant !== 'merkle') return { ok: false, error: 'no merkle pool for this sale' };
    if (!p.genesisTxid || !p.payoutPkh) return { ok: false, error: 'pool is not deployed yet' };

    const state = await resolveMerklePool({
      genesisTxid: p.genesisTxid, genesisVout: p.genesisVout ?? 0,
      k: p.k.toString(), supply: p.supply.toString(), payoutPkh: p.payoutPkh,
    });
    if ('error' in state) return { ok: false, error: state.error };

    // deliveries are recorded as Orders so a mint is never repeated for the same holder
    const delivered = await prisma.order.findMany({ where: { saleId, kind: 'curve_graduation_mint' } });
    const byPkh = new Map(delivered.map((o) => [(o.receiveAddress ?? '').toLowerCase(), o.txid]));

    const entries: FinalLedgerEntry[] = Object.entries(state.balances).map(([ownerPkh, amount]) => ({
      ownerPkh, amount: Number(amount), deliveredTxid: byPkh.get(ownerPkh.toLowerCase()) ?? null,
    }));
    return {
      ok: true, graduated: state.graduated, total: Number(state.sold), entries,
      issuanceTxid: p.sale.token.issuanceTxid ?? null, tokenId: p.sale.token.stasTokenId ?? null,
      genesisTxid: p.genesisTxid,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Owner-gated: confirm the pool really graduated and report how much must be minted. */
export async function prepareMerkleMint(input: { saleId: string; identityPubkey: string }): Promise<
  { ok: true; total: number; entries: FinalLedgerEntry[] } | { ok: false; error: string }
> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId: input.saleId }, include: { sale: { include: { token: { include: { project: true } } } } } });
    if (!p || p.variant !== 'merkle') return { ok: false, error: 'no merkle pool for this sale' };
    if (!(await isProjectOwner(p.sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (p.sale.token.issuanceTxid) return { ok: false, error: 'already minted' };

    const led = await getMerkleFinalLedger(input.saleId);
    if (!led.ok) return { ok: false, error: led.error };
    if (!led.graduated) return { ok: false, error: 'pool has not graduated — mint only after the reserve is released' };
    if (led.total <= 0) return { ok: false, error: 'nothing to mint' };
    return { ok: true, total: led.total, entries: led.entries };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Record the STAS issuance the owner's wallet just made for the graduated supply. */
export async function recordMerkleMint(input: { saleId: string; identityPubkey: string; issuanceTxid: string; tokenId: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId: input.saleId }, include: { sale: { include: { token: { include: { project: true } } } } } });
    if (!p || p.variant !== 'merkle') return { ok: false, error: 'no merkle pool' };
    if (!(await isProjectOwner(p.sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    await prisma.token.update({ where: { id: p.sale.token.id }, data: { issuanceTxid: input.issuanceTxid, stasTokenId: input.tokenId } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Record one holder's delivery. Idempotent per holder: the unique-ish guard is the existing
 * `curve_graduation_mint` Order, so a re-run of the distribution loop cannot double-mint to
 * someone who was already paid.
 */
export async function recordMerkleDelivery(input: {
  saleId: string; identityPubkey: string; ownerPkh: string; amount: number; txid: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId: input.saleId }, include: { sale: { include: { token: { include: { project: true } } } } } });
    if (!p || p.variant !== 'merkle') return { ok: false, error: 'no merkle pool' };
    if (!(await isProjectOwner(p.sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const already = await prisma.order.findFirst({ where: { saleId: input.saleId, kind: 'curve_graduation_mint', receiveAddress: input.ownerPkh.toLowerCase() } });
    if (already) return { ok: false, error: 'this holder has already been delivered' };
    await prisma.order.create({
      data: {
        // buyerIdentity is the PROJECT's (they ran the mint) — it is NOT the holder's, and must
        // never be used to find a holder's claim. `receiveAddress` carries the holder's ledger pkh,
        // lowercased so the claim lookup can match it exactly.
        saleId: input.saleId, buyerIdentity: input.identityPubkey, receiveAddress: input.ownerPkh.toLowerCase(),
        kind: 'curve_graduation_mint', tokens: BigInt(Math.floor(input.amount)), satsPaid: BigInt(0),
        state: 'settled', paymentTxid: input.txid, txid: input.txid,
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A holder's claimable graduation deliveries, keyed by their LEDGER PKH.
 *
 * The generic `getClaimables` matches on `buyerIdentity`, which cannot work here: the mint is run
 * by the project, so the delivery Order carries the PROJECT's identity, not the holder's — and we
 * never learn a holder's identity key at all, only the derived pkh their ledger balance was keyed
 * to. Matching on `buyerIdentity` therefore showed a holder nothing, and only appeared to work when
 * the project owner and the holder happened to be the same wallet.
 *
 * A holder's wallet can re-derive this pkh on demand, so it is the right key. Not gated: anyone may
 * ask what a given pkh is owed, which is the same property the final ledger already has.
 */
export async function getMerkleClaimables(saleId: string, ownerPkh: string): Promise<
  { orderId: string; txid: string; tokens: number; slug: string; ticker: string }[]
> {
  if (!/^[0-9a-fA-F]{40}$/.test(ownerPkh)) return [];
  const orders = await prisma.order.findMany({
    where: { saleId, kind: 'curve_graduation_mint', state: 'settled', txid: { not: null }, receiveAddress: ownerPkh.toLowerCase() },
    include: { sale: { include: { token: { include: { project: true } } } } },
    orderBy: { updatedAt: 'desc' },
  });
  // hide ones the holder already registered, so a claimed token stops re-appearing
  const registered = await prisma.event.findMany({
    where: { entity: 'Order', type: 'registered', entityId: { in: orders.map((o) => o.id) } },
    select: { entityId: true },
  });
  const done = new Set(registered.map((e) => e.entityId));
  return orders
    .filter((o) => !done.has(o.id))
    .map((o) => ({
      orderId: o.id, txid: o.txid!, tokens: Number(o.tokens),
      slug: o.sale.token.project.slug, ticker: o.sale.token.ticker,
    }));
}
