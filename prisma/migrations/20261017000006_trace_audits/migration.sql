-- Migration: 20261017000006_trace_audits
-- Adds reasoning trace auditing tables and columns:
-- - TraceAuditStatus enum
-- - trace_audits table
-- - trace_audit_runs table
-- - index on reasoning_traces(traceHash)
-- - denormalised lastAuditStatus and lastAuditedAt on reasoning_traces

CREATE TYPE "TraceAuditStatus" AS ENUM (
  'VERIFIED',
  'HASH_MISMATCH',
  'UNAVAILABLE',
  'UNKNOWN_TO_BACKEND',
  'WRONG_MARKET',
  'UNLINKED_IN_DB',
  'NOT_ON_CHAIN',
  'FOREIGN_AGENT',
  'ARCHIVED'
);

CREATE TABLE "trace_audit_runs" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "cursorTraceId" BIGINT,
  "stats" JSONB,

  CONSTRAINT "trace_audit_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "trace_audits" (
  "id" TEXT NOT NULL,
  "onChainTraceId" BIGINT,
  "traceId" TEXT,
  "onChainMarketId" BIGINT,
  "agent" TEXT,
  "action" TEXT,
  "ipfsCid" TEXT,
  "onChainHash" TEXT,
  "computedHash" TEXT,
  "status" "TraceAuditStatus" NOT NULL,
  "detail" JSONB,
  "runId" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "trace_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trace_audits_onChainTraceId_runId_key" ON "trace_audits"("onChainTraceId", "runId");
CREATE INDEX "trace_audits_status_checkedAt_idx" ON "trace_audits"("status", "checkedAt");
CREATE INDEX "trace_audits_traceId_checkedAt_idx" ON "trace_audits"("traceId", "checkedAt");

ALTER TABLE "trace_audits" ADD CONSTRAINT "trace_audits_traceId_fkey"
  FOREIGN KEY ("traceId") REFERENCES "reasoning_traces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reasoning trace additions
ALTER TABLE "reasoning_traces" ADD COLUMN "lastAuditStatus" "TraceAuditStatus",
ADD COLUMN "lastAuditedAt" TIMESTAMP(3);

CREATE INDEX "reasoning_traces_traceHash_idx" ON "reasoning_traces"("traceHash");
