-- Migration: 20261017000008_trace_publications (#131)
-- Adds the durable reasoning-trace publication queue:
-- - TracePublicationStatus enum
-- - trace_publications table (one row per trace that should be on-chain)
--
-- DATA MIGRATION (see CONTRIBUTING.md): the final INSERT backfills queue rows
-- for traces that were pinned but never published. Only MARKET_CREATION traces
-- are backfilled: trade traces don't record their direction, so their
-- publish_trace action (buy_yes / buy_no) can't be reconstructed. Backfilled
-- rows have a NULL payload because the trace is already pinned.

CREATE TYPE "TracePublicationStatus" AS ENUM (
  'AWAITING_PIN',
  'AWAITING_MARKET',
  'READY',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED'
);

CREATE TABLE "trace_publications" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "payload" JSONB,
  "status" "TracePublicationStatus" NOT NULL DEFAULT 'AWAITING_PIN',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedTxHash" TEXT,
  "submittedTraceId" BIGINT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "trace_publications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trace_publications_traceId_key" ON "trace_publications"("traceId");
CREATE INDEX "trace_publications_status_nextAttemptAt_idx" ON "trace_publications"("status", "nextAttemptAt");

ALTER TABLE "trace_publications"
  ADD CONSTRAINT "trace_publications_traceId_fkey"
  FOREIGN KEY ("traceId") REFERENCES "reasoning_traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DATA: backfill pinned-but-unpublished market-creation traces.
INSERT INTO "trace_publications" ("id", "traceId", "action", "payload", "status", "nextAttemptAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'create_market', NULL, 'AWAITING_MARKET', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "reasoning_traces" t
WHERE t."onChainTraceId" IS NULL
  AND t."traceHash" IS NOT NULL
  AND t."ipfsCid" IS NOT NULL
  AND t."decisionType" = 'MARKET_CREATION'
ON CONFLICT ("traceId") DO NOTHING;
