import cron from 'node-cron';
import { runTraceAudit } from '../services/trace-audit.service';
import { logger } from '../lib/logger';
import { config } from '../config';

let isRunning = false;

/**
 * Trace Audit Cron.
 * Periodically walks the reasoning-registry on-chain index,
 * verifies IPFS content hashes, detects discrepancies, and relinks missed records.
 */
export function startTraceAuditCron(): void {
  if (!config.TRACE_AUDIT_ENABLED) {
    logger.info('Trace audit cron is disabled by config (TRACE_AUDIT_ENABLED=false)');
    return;
  }

  cron.schedule(config.TRACE_AUDIT_CRON, async () => {
    if (isRunning) {
      logger.warn('Trace audit cron: previous run still active — skipping cycle');
      return;
    }

    isRunning = true;
    try {
      logger.info('Trace audit cron: starting trace audit cycle');
      const summary = await runTraceAudit();
      logger.info(
        {
          runId: summary.runId,
          totalAudited: summary.totalAudited,
          relinked: summary.relinked,
          counts: summary.counts,
        },
        'Trace audit cron completed',
      );
    } catch (err) {
      logger.error({ err }, 'Trace audit cron encountered an error');
    } finally {
      isRunning = false;
    }
  });

  logger.info({ cronSchedule: config.TRACE_AUDIT_CRON }, 'Trace audit cron scheduled');
}
