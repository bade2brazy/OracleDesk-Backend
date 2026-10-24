-- Migration: 20261017000003_foreign_keys_not_valid
-- Adds missing foreign keys (NOT VALID) and changes copy_trades ON DELETE CASCADE to RESTRICT to protect audit history.
-- Reason for RESTRICT: Deleting a market must not silently destroy subscriber copy-trade execution history.

-- Missing FK: payment_events.traceId -> reasoning_traces(id) ON DELETE SET NULL
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_traceId_fkey"
  FOREIGN KEY ("traceId") REFERENCES "reasoning_traces"("id") ON DELETE SET NULL NOT VALID;

-- Missing FK: positions.hedgeMarketId -> markets(id) ON DELETE SET NULL
ALTER TABLE "positions" ADD CONSTRAINT "positions_hedgeMarketId_fkey"
  FOREIGN KEY ("hedgeMarketId") REFERENCES "markets"("id") ON DELETE SET NULL NOT VALID;

-- Switch copy_trades foreign keys from CASCADE to RESTRICT
ALTER TABLE "copy_trades" DROP CONSTRAINT "copy_trades_traceId_fkey";
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_traceId_fkey"
  FOREIGN KEY ("traceId") REFERENCES "reasoning_traces"("id") ON DELETE RESTRICT NOT VALID;

ALTER TABLE "copy_trades" DROP CONSTRAINT "copy_trades_marketId_fkey";
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_marketId_fkey"
  FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT NOT VALID;
