-- Migration: 20261017000000_constraint_quarantine
-- Creates quarantine table for rows violating integrity checks before migration/repair.
-- Does not alter existing application tables or lock data.

CREATE TABLE IF NOT EXISTS "constraint_quarantine" (
  "id" TEXT NOT NULL,
  "table_name" TEXT NOT NULL,
  "row_id" TEXT NOT NULL,
  "check_name" TEXT NOT NULL,
  "row" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "constraint_quarantine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "constraint_quarantine_table_check_idx" ON "constraint_quarantine"("table_name", "check_name");
