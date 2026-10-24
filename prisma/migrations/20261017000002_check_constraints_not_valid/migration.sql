-- Migration: 20261017000002_check_constraints_not_valid
-- Adds CHECK constraints with NOT VALID so existing rows are not validated immediately and exclusive table locks are brief.
-- Constraints will be validated in 20261017000005_validate_constraints.

-- Probabilities and prices in [0, 1]
ALTER TABLE "markets" ADD CONSTRAINT "markets_initial_yes_prob_range" CHECK ("initialYesProb" >= 0 AND "initialYesProb" <= 1) NOT VALID;
ALTER TABLE "markets" ADD CONSTRAINT "markets_current_yes_prob_range" CHECK ("currentYesProb" IS NULL OR ("currentYesProb" >= 0 AND "currentYesProb" <= 1)) NOT VALID;
ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_prob_est_range" CHECK ("probabilityEstimate" >= 0 AND "probabilityEstimate" <= 1) NOT VALID;
ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_market_prob_range" CHECK ("marketProbability" >= 0 AND "marketProbability" <= 1) NOT VALID;
ALTER TABLE "positions" ADD CONSTRAINT "positions_entry_price_range" CHECK ("entryPrice" >= 0 AND "entryPrice" <= 1) NOT VALID;
ALTER TABLE "positions" ADD CONSTRAINT "positions_current_price_range" CHECK ("currentPrice" IS NULL OR ("currentPrice" >= 0 AND "currentPrice" <= 1)) NOT VALID;

-- Non-negative amounts
ALTER TABLE "trades" ADD CONSTRAINT "trades_amount_nonneg" CHECK ("amount" >= 0) NOT VALID;
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_amount_nonneg" CHECK ("amount" >= 0) NOT VALID;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_amount_paid_nonneg" CHECK ("amountPaid" >= 0) NOT VALID;
ALTER TABLE "spending_allowances" ADD CONSTRAINT "spending_allowances_daily_limit_nonneg" CHECK ("dailyLimit" >= 0) NOT VALID;
ALTER TABLE "spending_allowances" ADD CONSTRAINT "spending_allowances_per_trace_limit_nonneg" CHECK ("perTraceLimit" >= 0) NOT VALID;
ALTER TABLE "spending_allowances" ADD CONSTRAINT "spending_allowances_spent_today_nonneg" CHECK ("spentToday" >= 0) NOT VALID;
ALTER TABLE "markets" ADD CONSTRAINT "markets_min_liquidity_nonneg" CHECK ("minimumLiquidity" >= 0) NOT VALID;
ALTER TABLE "markets" ADD CONSTRAINT "markets_total_liquidity_nonneg" CHECK ("totalLiquidity" >= 0) NOT VALID;

-- Confidence interval JSON shapes
ALTER TABLE "markets" ADD CONSTRAINT "markets_ci_shape" CHECK (
  jsonb_typeof("confidenceInterval") = 'object' AND
  jsonb_typeof("confidenceInterval"->'lower') = 'number' AND
  jsonb_typeof("confidenceInterval"->'upper') = 'number' AND
  ("confidenceInterval"->>'lower')::float8 <= ("confidenceInterval"->>'upper')::float8
) NOT VALID;

ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_ci_shape" CHECK (
  jsonb_typeof("confidenceInterval") = 'object' AND
  jsonb_typeof("confidenceInterval"->'lower') = 'number' AND
  jsonb_typeof("confidenceInterval"->'upper') = 'number' AND
  ("confidenceInterval"->>'lower')::float8 <= ("confidenceInterval"->>'upper')::float8
) NOT VALID;

-- 64-hex hash formats
ALTER TABLE "markets" ADD CONSTRAINT "markets_question_hash_format" CHECK ("questionHash" IS NULL OR "questionHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "markets" ADD CONSTRAINT "markets_resolution_hash_format" CHECK ("resolutionHash" IS NULL OR "resolutionHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "markets" ADD CONSTRAINT "markets_creation_tx_hash_format" CHECK ("creationTxHash" IS NULL OR "creationTxHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_trace_hash_format" CHECK ("traceHash" IS NULL OR "traceHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_publish_tx_hash_format" CHECK ("publishTxHash" IS NULL OR "publishTxHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_tx_hash_format" CHECK ("txHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tx_hash_format" CHECK ("txHash" IS NULL OR "txHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_tx_hash_format" CHECK ("txHash" IS NULL OR "txHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_tx_hash_format" CHECK ("txHash" ~ '^[0-9a-f]{64}$') NOT VALID;

-- Raw amount digit format
ALTER TABLE "markets" ADD CONSTRAINT "markets_seed_amount_raw_digits" CHECK ("seedAmountRaw" IS NULL OR "seedAmountRaw" ~ '^[0-9]+$') NOT VALID;
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_amount_raw_digits" CHECK ("amountRaw" IS NULL OR "amountRaw" ~ '^[0-9]+$') NOT VALID;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_amount_raw_digits" CHECK ("amountRaw" IS NULL OR "amountRaw" ~ '^[0-9]+$') NOT VALID;

-- Non-negative on-chain u64 IDs
ALTER TABLE "markets" ADD CONSTRAINT "markets_onchain_id_nonneg" CHECK ("onChainMarketId" IS NULL OR "onChainMarketId" >= 0) NOT VALID;
ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_onchain_id_nonneg" CHECK ("onChainTraceId" IS NULL OR "onChainTraceId" >= 0) NOT VALID;
