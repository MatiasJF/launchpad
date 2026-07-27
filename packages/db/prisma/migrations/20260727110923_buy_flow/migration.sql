-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paymentTxid" TEXT;
ALTER TABLE "Order" ADD COLUMN "receiveAddress" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "payoutAddress" TEXT;
