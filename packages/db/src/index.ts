/**
 * Prisma client for the launchpad (SQLite). Off-chain mirror of state; the
 * chain is the source of truth (see docs/ARCHITECTURE.md).
 *
 * Run `pnpm db:generate` before first use, then `pnpm db:migrate`.
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export * from '@prisma/client';
