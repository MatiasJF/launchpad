-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CurvePool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'linear',
    "k" BIGINT NOT NULL,
    "supply" BIGINT NOT NULL,
    "sold" BIGINT NOT NULL DEFAULT 0,
    "seedReserveSats" BIGINT NOT NULL,
    "reserveSats" BIGINT NOT NULL DEFAULT 0,
    "ledgerBalances" TEXT,
    "poolTxid" TEXT,
    "poolVout" INTEGER,
    "scriptHex" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CurvePool_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_CurvePool" ("createdAt", "id", "k", "poolTxid", "poolVout", "reserveSats", "saleId", "scriptHex", "seedReserveSats", "sold", "status", "supply", "updatedAt") SELECT "createdAt", "id", "k", "poolTxid", "poolVout", "reserveSats", "saleId", "scriptHex", "seedReserveSats", "sold", "status", "supply", "updatedAt" FROM "CurvePool";
DROP TABLE "CurvePool";
ALTER TABLE "new_CurvePool" RENAME TO "CurvePool";
CREATE UNIQUE INDEX "CurvePool_saleId_key" ON "CurvePool"("saleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
