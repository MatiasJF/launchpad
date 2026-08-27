-- AlterTable
ALTER TABLE "CurvePool" ADD COLUMN "genesisTxid" TEXT;
ALTER TABLE "CurvePool" ADD COLUMN "genesisVout" INTEGER DEFAULT 0;
