-- Migration: 20261017000007_copy_trade_verification
-- Replaces TradeStatus with CopyTradeStatus enum on copy_trades.
-- Adds verification metadata columns (collateralRaw, sharesRaw, feeRaw, ledger, chainEventId, confirmedAt, failureCode, verificationAttempts, expiresAt).
-- Adds partial unique index on copy_trades(txHash).
-- Migrates existing EXECUTED copy trades to CONFIRMING so they are verified on-chain.

CREATE TYPE "CopyTradeStatus" AS ENUM (
  'PENDING',
  'CONFIRMING',
  'EXECUTED',
  'FAILED',
  'CANCELLED',
  'EXPIRED'
);

-- Alter copy_trades status column
ALTER TABLE "copy_trades" ALTER COLUMN "status" DROP DEFAULT;

-- Migrate existing EXECUTED rows to CONFIRMING so they are reverified on-chain
ALTER TABLE "copy_trades" ALTER COLUMN "status" TYPE "CopyTradeStatus"
  USING (
    CASE
      WHEN "status"::text = 'EXECUTED' THEN 'CONFIRMING'::"CopyTradeStatus"
      WHEN "status"::text = 'FAILED' THEN 'FAILED'::"CopyTradeStatus"
      WHEN "status"::text = 'CANCELLED' THEN 'CANCELLED'::"CopyTradeStatus"
      ELSE 'PENDING'::"CopyTradeStatus"
    END
  );

ALTER TABLE "copy_trades" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Add new verification columns
ALTER TABLE "copy_trades"
  ADD COLUMN "collateralRaw" TEXT,
  ADD COLUMN "sharesRaw" TEXT,
  ADD COLUMN "feeRaw" TEXT,
  ADD COLUMN "ledger" INTEGER,
  ADD COLUMN "chainEventId" TEXT,
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "copy_trades_txHash_key" ON "copy_trades"("txHash") WHERE "txHash" IS NOT NULL;
CREATE INDEX "copy_trades_status_expiresAt_idx" ON "copy_trades"("status", "expiresAt");
