-- Migration: 20261017000001_status_enums
-- Converts free-text status and payment-type columns to Postgres enums, and currency columns to SettlementCurrency.
-- Locks: ALTER COLUMN ... TYPE takes ACCESS EXCLUSIVE lock on payment_events, market_generation_jobs, subscriptions, spending_allowances.
-- Tables are small; lock durations are minimal.

CREATE TYPE "PaymentEventType" AS ENUM ('DAILY_PASS', 'PER_TRACE', 'REFUND');
CREATE TYPE "PaymentEventStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED');
CREATE TYPE "GenerationJobStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- payment_events
ALTER TABLE "payment_events" ALTER COLUMN "type" TYPE "PaymentEventType" USING upper("type")::"PaymentEventType";
ALTER TABLE "payment_events" ALTER COLUMN "status" TYPE "PaymentEventStatus" USING upper("status")::"PaymentEventStatus";
ALTER TABLE "payment_events" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "payment_events" ALTER COLUMN "currency" TYPE "SettlementCurrency" USING "currency"::"SettlementCurrency";
ALTER TABLE "payment_events" ALTER COLUMN "currency" SET DEFAULT 'USDC';

-- market_generation_jobs
ALTER TABLE "market_generation_jobs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "market_generation_jobs" ALTER COLUMN "status" TYPE "GenerationJobStatus" USING upper("status")::"GenerationJobStatus";
ALTER TABLE "market_generation_jobs" ALTER COLUMN "status" SET DEFAULT 'PROCESSING';

-- subscriptions
ALTER TABLE "subscriptions" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "subscriptions" ALTER COLUMN "currency" TYPE "SettlementCurrency" USING "currency"::"SettlementCurrency";
ALTER TABLE "subscriptions" ALTER COLUMN "currency" SET DEFAULT 'USDC';

-- spending_allowances
ALTER TABLE "spending_allowances" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "spending_allowances" ALTER COLUMN "currency" TYPE "SettlementCurrency" USING "currency"::"SettlementCurrency";
ALTER TABLE "spending_allowances" ALTER COLUMN "currency" SET DEFAULT 'USDC';
