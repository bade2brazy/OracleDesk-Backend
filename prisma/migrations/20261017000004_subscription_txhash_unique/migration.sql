-- Migration: 20261017000004_subscription_txhash_unique
-- Creates unique partial index on subscriptions(txHash) WHERE txHash IS NOT NULL.
-- Ensures one payment transaction hash can create at most one subscription.

CREATE UNIQUE INDEX "subscriptions_txHash_key" ON "subscriptions"("txHash") WHERE "txHash" IS NOT NULL;
