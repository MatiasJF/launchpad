/**
 * Prisma client for the launchpad (SQLite). Off-chain mirror of state; the
 * chain is the source of truth (see docs/ARCHITECTURE.md).
 *
 * Uses a global singleton so Next.js dev hot-reload doesn't open many clients.
 * Run `pnpm db:generate`, `pnpm db:migrate`, then `pnpm db:seed`.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from '@prisma/client';
