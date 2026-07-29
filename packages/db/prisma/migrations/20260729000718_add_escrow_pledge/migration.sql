-- CreateTable
CREATE TABLE "Pledge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "contributor" TEXT NOT NULL,
    "receiveAddress" TEXT NOT NULL,
    "txid" TEXT NOT NULL,
    "vout" INTEGER NOT NULL,
    "satoshis" BIGINT NOT NULL,
    "scriptHex" TEXT NOT NULL,
    "sigHex" TEXT NOT NULL,
    "pubkeyHex" TEXT NOT NULL,
    "derivationPrefix" TEXT,
    "derivationSuffix" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pledged',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Pledge_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Pledge_saleId_idx" ON "Pledge"("saleId");

-- CreateIndex
CREATE INDEX "Pledge_contributor_idx" ON "Pledge"("contributor");
