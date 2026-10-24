export type CronOutcome = 'success' | 'failure';

interface CronRun {
  startedAt: string;
  finishedAt: string;
  error?: string;
}

const lastRuns = new Map<string, { lastSuccess?: CronRun; lastFailure?: CronRun }>();

/** In-memory last success/failure per cron job (#111); not persisted. */
export function recordCronRun(job: string, outcome: CronOutcome, startedAt: Date, finishedAt: Date, error?: unknown): void {
  const entry = lastRuns.get(job) ?? {};
  const run: CronRun = { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
  if (outcome === 'success') {
    entry.lastSuccess = run;
  } else {
    run.error = error instanceof Error ? error.message : String(error);
    entry.lastFailure = run;
  }
  lastRuns.set(job, entry);
}

export function getCronStatus(): Record<string, { lastSuccess?: CronRun; lastFailure?: CronRun }> {
  return Object.fromEntries(lastRuns);
}
