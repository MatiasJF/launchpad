/**
 * FIX 1 (ADR-028 step-3, adversarial): a single on-chain STAS return must back AT MOST
 * ONE curve_sell refund. The guard is a UNIQUE index on Order.sellReturnOutpoint. This
 * test applies the real migrations to a throwaway SQLite DB and proves a second order on
 * the same returned outpoint is rejected (P2002) — closing the double-refund replay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const dbPkgDir = fileURLToPath(new URL('..', import.meta.url));

test('one STAS return backs at most one sell order (unique sellReturnOutpoint)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-db-'));
  const url = `file:${join(dir, 'test.db')}`;
  execSync('npx prisma migrate deploy', { cwd: dbPkgDir, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const n = Date.now();
    const acct = await prisma.account.create({ data: { identityPubkey: `pk-${n}` } });
    const proj = await prisma.project.create({ data: { ownerId: acct.id, slug: `slug-${n}`, name: 'T' } });
    const tok = await prisma.token.create({ data: { projectId: proj.id, name: 'T', ticker: 'T', totalSupply: 1000n } });
    const sale = await prisma.sale.create({ data: { tokenId: tok.id, type: 'bonding_curve', priceSats: 1n, allocationForSale: 1000n } });

    const returnTxid = 'a'.repeat(64);
    const outpoint = `${returnTxid}:0`;
    const order = (buyer) => ({ saleId: sale.id, buyerIdentity: buyer, kind: 'curve_sell', tokens: 4n, satsPaid: 6n, paymentTxid: returnTxid, returnVout: 0, sellReturnOutpoint: outpoint });

    // First sell order on this returned outpoint — accepted.
    await prisma.order.create({ data: order('seller-1') });

    // A second order replaying the SAME returned outpoint — REJECTED by the unique index.
    await assert.rejects(
      prisma.order.create({ data: order('attacker') }),
      (e) => e && e.code === 'P2002',
      'duplicate sellReturnOutpoint must throw P2002',
    );

    // Sanity: a DIFFERENT returned outpoint is still allowed.
    await prisma.order.create({ data: { ...order('seller-2'), sellReturnOutpoint: `${'b'.repeat(64)}:0` } });

    const sells = await prisma.order.count({ where: { saleId: sale.id, kind: 'curve_sell' } });
    assert.equal(sells, 2, 'exactly two distinct returns recorded (the replay was blocked)');
  } finally {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
