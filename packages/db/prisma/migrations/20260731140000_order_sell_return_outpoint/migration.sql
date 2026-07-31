-- AlterTable: curve_sell replay guard (ADR-028 step-3)
ALTER TABLE "Order" ADD COLUMN "returnVout" INTEGER;
ALTER TABLE "Order" ADD COLUMN "sellReturnOutpoint" TEXT;

-- One on-chain STAS return can back at most one sell refund.
CREATE UNIQUE INDEX "Order_sellReturnOutpoint_key" ON "Order"("sellReturnOutpoint");
