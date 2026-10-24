import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { prisma as defaultPrisma } from '../src/lib/prisma';

export interface ConstraintCheck {
  name: string;
  table: string;
  violation: string;
  fix?: string;
  severity: 'repairable' | 'manual';
}

export const CONSTRAINT_CHECKS: ConstraintCheck[] = [
  // Probabilities and prices in [0, 1]
  {
    name: 'markets_initial_yes_prob_range',
    table: 'markets',
    violation: '"initialYesProb" < 0 OR "initialYesProb" > 1',
    severity: 'manual',
  },
  {
    name: 'markets_current_yes_prob_range',
    table: 'markets',
    violation: '"currentYesProb" IS NOT NULL AND ("currentYesProb" < 0 OR "currentYesProb" > 1)',
    severity: 'manual',
  },
  {
    name: 'reasoning_traces_prob_est_range',
    table: 'reasoning_traces',
    violation: '"probabilityEstimate" < 0 OR "probabilityEstimate" > 1',
    severity: 'manual',
  },
  {
    name: 'reasoning_traces_market_prob_range',
    table: 'reasoning_traces',
    violation: '"marketProbability" < 0 OR "marketProbability" > 1',
    severity: 'manual',
  },
  {
    name: 'positions_entry_price_range',
    table: 'positions',
    violation: '"entryPrice" < 0 OR "entryPrice" > 1',
    severity: 'manual',
  },
  {
    name: 'positions_current_price_range',
    table: 'positions',
    violation: '"currentPrice" IS NOT NULL AND ("currentPrice" < 0 OR "currentPrice" > 1)',
    severity: 'manual',
  },

  // Non-negative amounts
  {
    name: 'trades_amount_nonneg',
    table: 'trades',
    violation: '"amount" < 0',
    severity: 'manual',
  },
  {
    name: 'copy_trades_amount_nonneg',
    table: 'copy_trades',
    violation: '"amount" < 0',
    severity: 'manual',
  },
  {
    name: 'subscriptions_amount_paid_nonneg',
    table: 'subscriptions',
    violation: '"amountPaid" < 0',
    severity: 'manual',
  },
  {
    name: 'spending_allowances_daily_limit_nonneg',
    table: 'spending_allowances',
    violation: '"dailyLimit" < 0',
    severity: 'manual',
  },
  {
    name: 'spending_allowances_per_trace_limit_nonneg',
    table: 'spending_allowances',
    violation: '"perTraceLimit" < 0',
    severity: 'manual',
  },
  {
    name: 'spending_allowances_spent_today_nonneg',
    table: 'spending_allowances',
    violation: '"spentToday" < 0',
    severity: 'manual',
  },
  {
    name: 'markets_min_liquidity_nonneg',
    table: 'markets',
    violation: '"minimumLiquidity" < 0',
    severity: 'manual',
  },
  {
    name: 'markets_total_liquidity_nonneg',
    table: 'markets',
    violation: '"totalLiquidity" < 0',
    severity: 'manual',
  },

  // Confidence intervals
  {
    name: 'markets_ci_shape',
    table: 'markets',
    violation:
      'jsonb_typeof("confidenceInterval") != \'object\' OR jsonb_typeof("confidenceInterval"->\'lower\') != \'number\' OR jsonb_typeof("confidenceInterval"->\'upper\') != \'number\' OR ("confidenceInterval"->>\'lower\')::float8 > ("confidenceInterval"->>\'upper\')::float8',
    severity: 'manual',
  },
  {
    name: 'reasoning_traces_ci_shape',
    table: 'reasoning_traces',
    violation:
      'jsonb_typeof("confidenceInterval") != \'object\' OR jsonb_typeof("confidenceInterval"->\'lower\') != \'number\' OR jsonb_typeof("confidenceInterval"->\'upper\') != \'number\' OR ("confidenceInterval"->>\'lower\')::float8 > ("confidenceInterval"->>\'upper\')::float8',
    severity: 'manual',
  },

  // Hash format checks
  {
    name: 'markets_question_hash_format',
    table: 'markets',
    violation: '"questionHash" IS NOT NULL AND "questionHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "markets" SET "questionHash" = lower(regexp_replace("questionHash", \'^0x\', \'\')) WHERE "questionHash" IS NOT NULL AND lower(regexp_replace("questionHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'markets_resolution_hash_format',
    table: 'markets',
    violation: '"resolutionHash" IS NOT NULL AND "resolutionHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "markets" SET "resolutionHash" = lower(regexp_replace("resolutionHash", \'^0x\', \'\')) WHERE "resolutionHash" IS NOT NULL AND lower(regexp_replace("resolutionHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'markets_creation_tx_hash_format',
    table: 'markets',
    violation: '"creationTxHash" IS NOT NULL AND "creationTxHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "markets" SET "creationTxHash" = lower(regexp_replace("creationTxHash", \'^0x\', \'\')) WHERE "creationTxHash" IS NOT NULL AND lower(regexp_replace("creationTxHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'reasoning_traces_trace_hash_format',
    table: 'reasoning_traces',
    violation: '"traceHash" IS NOT NULL AND "traceHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "reasoning_traces" SET "traceHash" = lower(regexp_replace("traceHash", \'^0x\', \'\')) WHERE "traceHash" IS NOT NULL AND lower(regexp_replace("traceHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'reasoning_traces_publish_tx_hash_format',
    table: 'reasoning_traces',
    violation: '"publishTxHash" IS NOT NULL AND "publishTxHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "reasoning_traces" SET "publishTxHash" = lower(regexp_replace("publishTxHash", \'^0x\', \'\')) WHERE "publishTxHash" IS NOT NULL AND lower(regexp_replace("publishTxHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'payment_events_tx_hash_format',
    table: 'payment_events',
    violation: '"txHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "payment_events" SET "txHash" = lower(regexp_replace("txHash", \'^0x\', \'\')) WHERE lower(regexp_replace("txHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'subscriptions_tx_hash_format',
    table: 'subscriptions',
    violation: '"txHash" IS NOT NULL AND "txHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "subscriptions" SET "txHash" = lower(regexp_replace("txHash", \'^0x\', \'\')) WHERE "txHash" IS NOT NULL AND lower(regexp_replace("txHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'copy_trades_tx_hash_format',
    table: 'copy_trades',
    violation: '"txHash" IS NOT NULL AND "txHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "copy_trades" SET "txHash" = lower(regexp_replace("txHash", \'^0x\', \'\')) WHERE "txHash" IS NOT NULL AND lower(regexp_replace("txHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },
  {
    name: 'chain_events_tx_hash_format',
    table: 'chain_events',
    violation: '"txHash" !~ \'^[0-9a-f]{64}$\'',
    fix: 'UPDATE "chain_events" SET "txHash" = lower(regexp_replace("txHash", \'^0x\', \'\')) WHERE lower(regexp_replace("txHash", \'^0x\', \'\')) ~ \'^[0-9a-f]{64}$\'',
    severity: 'repairable',
  },

  // Raw amounts
  {
    name: 'markets_seed_amount_raw_digits',
    table: 'markets',
    violation: '"seedAmountRaw" IS NOT NULL AND "seedAmountRaw" !~ \'^[0-9]+$\'',
    severity: 'manual',
  },
  {
    name: 'copy_trades_amount_raw_digits',
    table: 'copy_trades',
    violation: '"amountRaw" IS NOT NULL AND "amountRaw" !~ \'^[0-9]+$\'',
    severity: 'manual',
  },
  {
    name: 'payment_events_amount_raw_digits',
    table: 'payment_events',
    violation: '"amountRaw" IS NOT NULL AND "amountRaw" !~ \'^[0-9]+$\'',
    severity: 'manual',
  },

  // Non-negative IDs
  {
    name: 'markets_onchain_id_nonneg',
    table: 'markets',
    violation: '"onChainMarketId" IS NOT NULL AND "onChainMarketId" < 0',
    severity: 'manual',
  },
  {
    name: 'reasoning_traces_onchain_id_nonneg',
    table: 'reasoning_traces',
    violation: '"onChainTraceId" IS NOT NULL AND "onChainTraceId" < 0',
    severity: 'manual',
  },

  // Foreign keys
  {
    name: 'payment_events_trace_fk',
    table: 'payment_events',
    violation:
      '"traceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "reasoning_traces" t WHERE t."id" = "payment_events"."traceId")',
    fix: 'UPDATE "payment_events" SET "metadata" = jsonb_set(COALESCE("metadata", \'{}\'::jsonb), \'{orphanTraceId}\', to_jsonb("traceId")), "traceId" = NULL WHERE "traceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "reasoning_traces" t WHERE t."id" = "payment_events"."traceId")',
    severity: 'repairable',
  },
  {
    name: 'positions_hedge_market_fk',
    table: 'positions',
    violation:
      '"hedgeMarketId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "markets" m WHERE m."id" = "positions"."hedgeMarketId")',
    fix: 'UPDATE "positions" SET "hedgeMarketId" = NULL WHERE "hedgeMarketId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "markets" m WHERE m."id" = "positions"."hedgeMarketId")',
    severity: 'repairable',
  },

  // Uniqueness
  {
    name: 'subscriptions_txhash_unique',
    table: 'subscriptions',
    violation:
      '"txHash" IS NOT NULL AND "txHash" IN (SELECT "txHash" FROM "subscriptions" WHERE "txHash" IS NOT NULL GROUP BY "txHash" HAVING count(*) > 1)',
    severity: 'manual',
  },
];

export interface AuditResult {
  checks: Array<{
    name: string;
    table: string;
    severity: 'repairable' | 'manual';
    violatingCount: number;
    fixedCount?: number;
    remainingCount: number;
    sampleViolations?: any[];
  }>;
  totalViolations: number;
  fixed: number;
  remainingManual: number;
}

export async function runAudit(opts: {
  fix?: boolean;
  jsonPath?: string;
  prisma?: any;
}): Promise<AuditResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const results: AuditResult['checks'] = [];
  let totalViolations = 0;
  let totalFixed = 0;
  let remainingManual = 0;

  for (const check of CONSTRAINT_CHECKS) {
    try {
      // Find violating rows
      const selectQuery = `SELECT id, row_to_json(t.*) as json_row FROM "${check.table}" t WHERE ${check.violation}`;
      const badRows: any[] = await prisma.$queryRawUnsafe(selectQuery);
      const count = badRows.length;
      totalViolations += count;

      let fixedCount = 0;

      if (count > 0 && opts.fix && check.fix) {
        // Quarantine violating rows first
        for (const row of badRows) {
          const qId = uuidv4();
          await prisma.$executeRawUnsafe(
            `INSERT INTO "constraint_quarantine" ("id", "table_name", "row_id", "check_name", "row", "created_at")
             VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
            qId,
            check.table,
            String(row.id),
            check.name,
            JSON.stringify(row.json_row),
          ).catch(() => {});
        }

        // Apply fix
        fixedCount = await prisma.$executeRawUnsafe(check.fix);
        totalFixed += fixedCount;
      }

      const remaining = count - fixedCount;
      if (remaining > 0 && check.severity === 'manual') {
        remainingManual += remaining;
      }

      results.push({
        name: check.name,
        table: check.table,
        severity: check.severity,
        violatingCount: count,
        fixedCount: opts.fix ? fixedCount : undefined,
        remainingCount: remaining,
        sampleViolations: badRows.slice(0, 3).map((r) => r.json_row),
      });
    } catch (err) {
      // Table might not exist yet if running before migrations
      results.push({
        name: check.name,
        table: check.table,
        severity: check.severity,
        violatingCount: 0,
        remainingCount: 0,
      });
    }
  }

  const summary: AuditResult = {
    checks: results,
    totalViolations,
    fixed: totalFixed,
    remainingManual,
  };

  if (opts.jsonPath) {
    fs.writeFileSync(opts.jsonPath, JSON.stringify(summary, null, 2));
  }

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const jsonIdx = args.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? args[jsonIdx + 1] : undefined;

  console.log(`Running constraint audit (fix: ${fix})...`);
  const result = await runAudit({ fix, jsonPath });

  console.log('\nAudit Summary:');
  console.log(`  Total violations found: ${result.totalViolations}`);
  console.log(`  Fixed: ${result.fixed}`);
  console.log(`  Remaining manual violations: ${result.remainingManual}`);

  for (const c of result.checks) {
    if (c.violatingCount > 0) {
      console.log(`  - [${c.severity.toUpperCase()}] ${c.name} on ${c.table}: ${c.violatingCount} violations (remaining: ${c.remainingCount})`);
    }
  }

  if (result.remainingManual > 0) {
    console.error('\nAudit failed: manual violations require human inspection.');
    process.exit(1);
  }

  if (!fix && result.totalViolations > 0) {
    console.error('\nAudit failed: violations present (re-run with --fix).');
    process.exit(1);
  }

  console.log('\nAudit passed.');
  process.exit(0);
}

if (process.argv[1]?.endsWith('audit-constraints.ts')) {
  main().catch((err) => {
    console.error('Fatal error running audit:', err);
    process.exit(1);
  });
}
