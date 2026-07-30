-- CreateTable
CREATE TABLE "CurvePool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "k" BIGINT NOT NULL,
    "supply" BIGINT NOT NULL,
    "sold" BIGINT NOT NULL DEFAULT 0,
    "seedReserveSats" BIGINT NOT NULL,
    "reserveSats" BIGINT NOT NULL DEFAULT 0,
    "poolTxid" TEXT,
    "poolVout" INTEGER,
    "scriptHex" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CurvePool_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CurvePool_saleId_key" ON "CurvePool"("saleId");
