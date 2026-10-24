-- Migration: 20261017000005_validate_constraints
-- Validates all constraints added in earlier migrations.
-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE lock; reads and writes proceed concurrently.

ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_initial_yes_prob_range";
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_current_yes_prob_range";
ALTER TABLE "reasoning_traces" VALIDATE CONSTRAINT "reasoning_traces_prob_est_range";
ALTER TABLE "reasoning_traces" VALIDATE CONSTRAINT "reasoning_traces_market_prob_range";
ALTER TABLE "positions" VALIDATE CONSTRAINT "positions_entry_price_range";
ALTER TABLE "positions" VALIDATE CONSTRAINT "positions_current_price_range";

ALTER TABLE "trades" VALIDATE CONSTRAINT "trades_amount_nonneg";
ALTER TABLE "copy_trades" VALIDATE CONSTRAINT "copy_trades_amount_nonneg";
ALTER TABLE "subscriptions" VALIDATE CONSTRAINT "subscriptions_amount_paid_nonneg";
ALTER TABLE "spending_allowances" VALIDATE CONSTRAINT "spending_allowances_daily_limit_nonneg";
ALTER TABLE "spending_allowances" VALIDATE CONSTRAINT "spending_allowances_per_trace_limit_nonneg";
ALTER TABLE "spending_allowances" VALIDATE CONSTRAINT "spending_allowances_spent_today_nonneg";
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_min_liquidity_nonneg";
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_total_liquidity_nonneg";

ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_ci_shape";
ALTER TABLE "reasoning_traces" VALIDATE CONSTRAINT "reasoning_traces_ci_shape";

ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_question_hash_format";
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_resolution_hash_format";
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_creation_tx_hash_format";
ALTER TABLE "reasoning_traces" VALIDATE CONSTRAINT "reasoning_traces_trace_hash_format";
ALTER TABLE "reasoning_traces" VALIDATE CONSTRAINT "reasoning_traces_publish_tx_hash_format";
ALTER TABLE "payment_events" VALIDATE CONSTRAINT "payment_events_tx_hash_format";
ALTER TABLE "subscriptions" VALIDATE CONSTRAINT "subscriptions_tx_hash_format";
ALTER TABLE "copy_trades" VALIDATE CONSTRAINT "copy_trades_tx_hash_format";
ALTER TABLE "chain_events" VALIDATE CONSTRAINT "chain_events_tx_hash_format";

ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_seed_amount_raw_digits";
ALTER TABLE "copy_trades" VALIDATE CONSTRAINT "copy_trades_amount_raw_digits";
ALTER TABLE "payment_events" VALIDATE CONSTRAINT "payment_events_amount_raw_digits";

ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_onchain_id_nonneg";
ALTER TABLE "reasoning_traces" VALIDATE CONSTRAINT "reasoning_traces_onchain_id_nonneg";

ALTER TABLE "payment_events" VALIDATE CONSTRAINT "payment_events_traceId_fkey";
ALTER TABLE "positions" VALIDATE CONSTRAINT "positions_hedgeMarketId_fkey";
ALTER TABLE "copy_trades" VALIDATE CONSTRAINT "copy_trades_traceId_fkey";
ALTER TABLE "copy_trades" VALIDATE CONSTRAINT "copy_trades_marketId_fkey";
