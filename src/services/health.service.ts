/**
 * Liveness and readiness (#111).
 *
 * Liveness is process-level only (event-loop delay, fatal flag) and never
 * touches a dependency, so a database outage cannot restart every instance.
 * Readiness runs one probe per dependency with a timeout, caches results for a
 * short TTL and shares one in-flight run between concurrent callers.
 */
import { monitorEventLoopDelay } from 'perf_hooks';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getRedis } from '../lib/redis';
import { rpcServer } from './stellar/clients';
import { CURSOR_ID } from './indexer.service';

export type ProbeName = 'database' | 'redis' | 'rpc' | 'indexer';

export interface ProbeResult {
  name: ProbeName;
  ok: boolean;
  critical: boolean;
  latencyMs: number;
  checkedAt: string;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface ProbeContext {
  /** Cached or in-flight result of another probe (single run, never a second call). */
  result(name: ProbeName): Promise<ProbeResult>;
}

export interface Probe {
  name: ProbeName;
  run(signal: AbortSignal, ctx: ProbeContext): Promise<Omit<ProbeResult, 'name' | 'critical' | 'latencyMs' | 'checkedAt'>>;
}

export interface HealthServiceDeps {
  probes: Probe[];
  ttlMs: number;
  timeoutMs: number;
  criticality: Record<ProbeName, boolean>;
  maxLoopDelayMs?: number;
  now?: () => number;
}

const FAILURE_TTL_MS = 500;
const LOG_INTERVAL_MS = 60_000;

/** Only these classes reach responses; the full error is logged instead. */
function sanitise(err: unknown): string {
  const text = err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err);
  if (/^timeout\b/.test(text)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Can't reach database/i.test(text)) return 'connection_refused';
  return 'unavailable';
}

export function createHealthService(deps: HealthServiceDeps) {
  const now = deps.now ?? Date.now;
  const probes = new Map(deps.probes.map((p) => [p.name, p]));
  const cache = new Map<ProbeName, { result: ProbeResult; expiresAt: number }>();
  const inflight = new Map<ProbeName, Promise<ProbeResult>>();
  const lastLogged = new Map<ProbeName, number>();
  const ctx: ProbeContext = { result: (name) => get(name) };
  let draining = false;
  let fatal = false;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  async function execute(probe: Probe): Promise<ProbeResult> {
    const started = now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const base = { name: probe.name, critical: deps.criticality[probe.name] };
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('timeout'));
        }, deps.timeoutMs);
        timer.unref();
      });
      const outcome = await Promise.race([probe.run(controller.signal, ctx), timeout]);
      return { ...base, ...outcome, latencyMs: now() - started, checkedAt: new Date(now()).toISOString() };
    } catch (err) {
      if (now() - (lastLogged.get(probe.name) ?? -Infinity) >= LOG_INTERVAL_MS) {
        lastLogged.set(probe.name, now());
        logger.warn({ probe: probe.name, err: err instanceof Error ? err.message : err }, 'Health probe failed');
      }
      return { ...base, ok: false, error: sanitise(err), latencyMs: now() - started, checkedAt: new Date(now()).toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

  function get(name: ProbeName): Promise<ProbeResult> {
    const hit = cache.get(name);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.result);
    const running = inflight.get(name);
    if (running) return running;
    const run = execute(probes.get(name)!)
      .then((result) => {
        cache.set(name, { result, expiresAt: now() + (result.ok ? deps.ttlMs : Math.min(FAILURE_TTL_MS, deps.ttlMs)) });
        return result;
      })
      .finally(() => inflight.delete(name));
    inflight.set(name, run);
    return run;
  }

  return {
    async readiness(): Promise<{ ready: boolean; checks: ProbeResult[] }> {
      const checks = await Promise.all(deps.probes.map((p) => get(p.name)));
      return { ready: checks.every((c) => c.ok || !c.critical), checks };
    },
    /** Process-level only: never calls a dependency probe. */
    liveness(): { alive: boolean; loopDelayMs: number; fatal: boolean } {
      const p99 = loop.percentile(99) / 1e6;
      loop.reset();
      const loopDelayMs = Number.isFinite(p99) ? p99 : 0;
      return { alive: !fatal && loopDelayMs <= (deps.maxLoopDelayMs ?? 2000), loopDelayMs, fatal };
    },
    markFatal(): void { fatal = true; },
    isDraining: () => draining,
    startDraining(): void { draining = true; },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;

export const defaultProbes: Probe[] = [
  {
    name: 'database',
    async run() {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    },
  },
  {
    name: 'redis',
    async run() {
      const redis = getRedis();
      // ioredis queues commands while reconnecting; fail fast instead of waiting on retries.
      if (redis.status !== 'ready') return { ok: false, error: 'connection_refused' };
      await redis.ping();
      return { ok: true };
    },
  },
  {
    name: 'rpc',
    async run() {
      const health = await rpcServer.getHealth();
      const detail = { latestLedger: health.latestLedger, oldestLedger: health.oldestLedger };
      return health.status === 'healthy' ? { ok: true, detail } : { ok: false, detail, error: 'rpc_unhealthy' };
    },
  },
  {
    name: 'indexer',
    async run(_signal, ctx) {
      if (!config.INDEXER_ENABLED) return { ok: true, detail: { enabled: false } };
      const row = await prisma.indexerCursor.findUnique({ where: { id: CURSOR_ID } });
      // A fresh instance has no cursor yet; that is not a reason to fail readiness.
      if (!row) return { ok: true, detail: { enabled: true, state: 'initialising' } };
      const rpc = await ctx.result('rpc');
      const latest = rpc.detail?.latestLedger;
      const lagLedgers = typeof latest === 'number' ? latest - row.lastLedger : null;
      const staleMs = Date.now() - row.updatedAt.getTime();
      const detail = { enabled: true, lastLedger: row.lastLedger, lagLedgers, staleMs };
      const lagging =
        (lagLedgers !== null && lagLedgers > config.INDEXER_MAX_LAG_LEDGERS) || staleMs > config.INDEXER_MAX_STALENESS_MS;
      return lagging ? { ok: false, detail, error: 'lagging' } : { ok: true, detail };
    },
  },
];

export const health = createHealthService({
  probes: defaultProbes,
  ttlMs: config.HEALTH_CACHE_TTL_MS,
  timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
  criticality: {
    database: config.HEALTH_CRITICAL.includes('database'),
    redis: config.HEALTH_CRITICAL.includes('redis'),
    rpc: config.HEALTH_CRITICAL.includes('rpc'),
    indexer: config.HEALTH_CRITICAL.includes('indexer'),
  },
  maxLoopDelayMs: config.LIVENESS_MAX_LOOP_DELAY_MS,
});
