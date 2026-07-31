'use server';

import { prisma } from '@launchpad/db';
import { revalidatePath } from 'next/cache';
import { planMint } from '@launchpad/bsv/issue';
import { isProjectOwner } from './account-actions';
import { getOperator } from './operator-wallet';
import { stasGenesisScript } from './stas-service';

/**
 * Option-B "stas" bonding-curve server actions (ADR-028). The on-chain state is split:
 *   - a small SAT reserve covenant (StasCurvePool) whose value is the reserve and whose
 *     script carries `sold` — deployed + seeded by the project owner's wallet;
 *   - the full token supply issued as REAL STAS into the operator vault, from which the
 *     operator delivers tokens to buyers on each buy.
 * The operator never holds the owner's keys; these actions persist the covenant's on-chain
 * outpoint + the minted inventory so trades can be sequenced against the latest state (BSV
 * has no global mutable state). Deploy and mint are TWO independent signed txs, each modelled
 * as a prepare/record split mirroring curve-actions / ledger-actions and the issuance flow —
 * nothing here broadcasts; the client wallet signs, then records.
 */

// Phase-1 curve params for the stas variant. Baked into the reserve covenant at genesis
// (k = price slope, supply = max tokens the curve sells). Mirrors the ledger variant's
// hardcoded params; the full `supply` is minted as STAS into the operator vault.
const STAS_K = 1n;
const STAS_SUPPLY = 1000n;

/**
 * Owner-gated: create/refresh the stas CurvePool row (draft) + return the genesis reserve-
 * covenant script the owner's wallet deploys (a createAction output of `seedReserveSats`
 * locked to this script). Mirrors createLedgerPool.
 */
export async function createStasPool(input: { saleId: string; identityPubkey: string; seedReserveSats: number }): Promise<{ ok: boolean; scriptHex?: string; error?: string }> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    if (input.seedReserveSats < 1) return { ok: false, error: 'seed reserve must be positive' };
    const existing = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (existing && existing.status === 'live') return { ok: false, error: 'pool already live' };

    const { pkh: operatorPkh } = await getOperator();
    const scriptHex = await stasGenesisScript(STAS_K, STAS_SUPPLY, operatorPkh);
    await prisma.curvePool.upsert({
      where: { saleId: input.saleId },
      create: { saleId: input.saleId, variant: 'stas', k: STAS_K, supply: STAS_SUPPLY, seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), operatorPkh, status: 'draft' },
      update: { variant: 'stas', seedReserveSats: BigInt(Math.floor(input.seedReserveSats)), operatorPkh },
    });
    return { ok: true, scriptHex };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Owner-gated: record the deployed reserve-covenant UTXO (draft -> live). Mirrors
 * markCurvePoolDeployed. The client broadcasts the deploy tx, then calls this.
 */
export async function markStasPoolDeployed(input: {
  saleId: string; identityPubkey: string; txid: string; vout: number; scriptHex: string; reserveSats: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) return { ok: false, error: 'invalid deploy txid' };
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };

    await prisma.curvePool.update({
      where: { saleId: input.saleId },
      data: {
        poolTxid: input.txid,
        poolVout: input.vout,
        scriptHex: input.scriptHex,
        reserveSats: BigInt(Math.floor(input.reserveSats)),
        sold: 0n,
        status: 'live',
      },
    });
    await prisma.sale.update({ where: { id: input.saleId }, data: { status: 'live' } });
    await prisma.event.create({ data: { entity: 'CurvePool', entityId: input.saleId, type: 'stas_pool_deployed' } });
    revalidatePath(`/sale/${sale.token.project.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Owner-gated: build the mint plan for issuing the full curve `supply` as ONE STAS
 * issuance DELIVERED TO THE OPERATOR VAULT (the owner = operator, so the STAS output
 * locks to hash160(operator pubkey) = the vault). Mirrors buildMintPlan: the client
 * passes its wallet-derived REDEMPTION pubkey (the provenance anchor / tokenId); nothing
 * here touches a private key. The client then runs the CONTRACT -> ISSUE genesis + broadcasts,
 * and calls recordStasMint. `owner` is the operator's public key from getOperator().
 */
export async function prepareStasMint(input: { saleId: string; identityPubkey: string; redemptionPubkey: string }): Promise<
  | { ok: true; symbol: string; supply: number; tokenSatoshis: number; tokenId: string; ownerAddress: string; ownerPkh: string; stasScriptHex: string; estFeeSats: number; totalSatsRequired: number }
  | { ok: false; error: string }
> {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (sale.type !== 'bonding_curve') return { ok: false, error: 'not a bonding-curve sale' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };

    const symbol = sale.token.ticker.replace(/^\$/, '');
    const supply = Number(pool.supply);
    const { pubHex: operatorPubHex } = await getOperator();
    // owner = operator vault (STAS locks to the operator's pkh); redemption = wallet anchor.
    const plan = planMint({ symbol, supply }, operatorPubHex, input.redemptionPubkey);
    return { ok: true, ...plan };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Owner-gated: record the completed STAS inventory mint (the CONTRACT -> ISSUE genesis the
 * client broadcast). Persists the tokenId + issuance txid on the Token (the on-chain
 * signature is the real authority; this is bookkeeping over a committed fact). Mirrors
 * recordIssuance but does NOT flip sale status — the reserve deploy handles that.
 */
export async function recordStasMint(input: { saleId: string; identityPubkey: string; issuanceTxid: string; tokenId: string }): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.issuanceTxid)) return { ok: false, error: 'invalid issuance txid' };
  try {
    const sale = await prisma.sale.findUnique({ where: { id: input.saleId }, include: { token: { include: { project: true } } } });
    if (!sale) return { ok: false, error: 'sale not found' };
    if (!(await isProjectOwner(sale.token.project.id, input.identityPubkey))) return { ok: false, error: 'not the project owner' };
    const pool = await prisma.curvePool.findUnique({ where: { saleId: input.saleId } });
    if (!pool || pool.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };

    await prisma.token.update({
      where: { id: sale.token.id },
      data: { issuanceTxid: input.issuanceTxid, stasTokenId: input.tokenId },
    });
    await prisma.event.create({ data: { entity: 'Token', entityId: sale.token.id, type: 'stas_inventory_minted', payloadHash: input.issuanceTxid } });
    revalidatePath(`/sale/${sale.token.project.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Current stas pool state + derived curve info + minted inventory reference (for building a
 * buy/sell client-side later). Mirrors getLedgerPool / getCurvePoolState.
 */
export async function getStasPool(saleId: string): Promise<
  | { ok: true; poolTxid: string; poolVout: number; scriptHex: string; reserveSats: number; seedReserveSats: number; sold: number; k: string; supply: string; operatorPkh: string; stasTokenId: string | null; issuanceTxid: string | null }
  | { ok: false; error: string }
> {
  try {
    const p = await prisma.curvePool.findUnique({ where: { saleId }, include: { sale: { include: { token: true } } } });
    if (!p || p.variant !== 'stas') return { ok: false, error: 'no stas pool for this sale' };
    if (p.status !== 'live' || !p.poolTxid || p.poolVout == null || !p.scriptHex || !p.operatorPkh) return { ok: false, error: 'pool is not live yet' };
    return {
      ok: true,
      poolTxid: p.poolTxid, poolVout: p.poolVout, scriptHex: p.scriptHex,
      reserveSats: Number(p.reserveSats), seedReserveSats: Number(p.seedReserveSats), sold: Number(p.sold),
      k: p.k.toString(), supply: p.supply.toString(), operatorPkh: p.operatorPkh,
      stasTokenId: p.sale.token.stasTokenId, issuanceTxid: p.sale.token.issuanceTxid,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
