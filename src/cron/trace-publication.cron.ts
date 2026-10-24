import cron from 'node-cron';
import { processTracePublications } from '../jobs/trace-publication.worker';
import { logger } from '../lib/logger';
import { config } from '../config';

let isRunning = false;

/**
 * Trace publication cron (#131). Every TRACE_PUBLISH_CRON (default 30 s) it
 * advances queued trace publications: pin, wait for the on-chain market,
 * publish once, and re-check unconfirmed submissions. Rows are claimed with
 * FOR UPDATE SKIP LOCKED, so several processes can run this safely.
 */
export function startTracePublicationCron(): void {
  if (!config.TRACE_PUBLISH_ENABLED) {
    logger.info('Trace publication cron is disabled by config (TRACE_PUBLISH_ENABLED=false)');
    return;
  }

  cron.schedule(config.TRACE_PUBLISH_CRON, async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await processTracePublications();
    } catch (err) {
      logger.error({ err }, 'Trace publication cron encountered an error');
    } finally {
      isRunning = false;
    }
  });

  logger.info({ cronSchedule: config.TRACE_PUBLISH_CRON }, 'Trace publication cron scheduled');
}
