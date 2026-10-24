import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

type Mod = typeof import('../src/services/health.service');
type ProbeName = import('../src/services/health.service').ProbeName;

const allCritical: Record<ProbeName, boolean> = { database: true, redis: true, rpc: true, indexer: true };

async function service(
  probes: import('../src/services/health.service').Probe[],
  over: Partial<Parameters<Mod['createHealthService']>[0]> = {},
) {
  const { createHealthService } = await import('../src/services/health.service');
  return createHealthService({ probes, ttlMs: 2000, timeoutMs: 1500, criticality: allCritical, ...over });
}

const probe = (name: ProbeName, run: () => Promise<{ ok: boolean; error?: string }>) => ({ name, run });
const up = (name: ProbeName) => probe(name, async () => ({ ok: true }));

async function withRouter(health: Awaited<ReturnType<typeof service>>, fn: (base: string) => Promise<void>) {
  const { createHealthRouter } = await import('../src/routes/health.routes');
  const app = express();
  // A limiter of 1 request proves the probe routes sit in front of it.
  app.use(createHealthRouter(health));
  app.use(rateLimit({ windowMs: 60_000, limit: 1 }));
  app.get('/limited', (_req, res) => void res.json({}));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('livez returns 200 without touching any dependency', async () => {
  const boom = (name: ProbeName) => probe(name, async () => { throw new Error('probe must not run'); });
  const health = await service([boom('database'), boom('redis')]);
  await withRouter(health, async (base) => {
    const res = await fetch(`${base}/livez`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.status, 'alive');
  });
});

test('readyz returns 200 when all critical probes pass and a non-critical one fails', async () => {
  const health = await service(
    [up('database'), probe('rpc', async () => ({ ok: false, error: 'rpc_unhealthy' }))],
    { criticality: { ...allCritical, rpc: false } },
  );
  await withRouter(health, async (base) => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'ready');
    assert.equal(body.data.checks.find((c: { name: string }) => c.name === 'rpc').ok, false);
  });
});

test('readyz returns 503 when a critical probe fails, with sanitised error', async () => {
  const health = await service([probe('database', async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); })]);
  await withRouter(health, async (base) => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_READY');
    assert.equal(body.data.checks[0].error, 'connection_refused');
    assert.ok(!JSON.stringify(body).includes('10.0.0.5'));
  });
});

test('a hanging probe times out within HEALTH_PROBE_TIMEOUT_MS', async () => {
  const hang = probe('redis', () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500)));
  const health = await service([hang], { timeoutMs: 30 });
  const started = Date.now();
  const { ready, checks } = await health.readiness();
  assert.ok(Date.now() - started < 300);
  assert.equal(ready, false);
  assert.equal(checks[0].error, 'timeout');
});

test('concurrent readyz calls share one in-flight probe run', async () => {
  let calls = 0;
  const slow = probe('database', async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true };
  });
  const health = await service([slow]);
  await Promise.all([health.readiness(), health.readiness(), health.readiness()]);
  assert.equal(calls, 1);
});

test('results are cached for ttl and failures for the shorter ttl', async () => {
  let t = 1_000_000;
  let calls = 0;
  let ok = true;
  const flaky = probe('database', async () => { calls++; return { ok }; });
  const health = await service([flaky], { now: () => t });
  await health.readiness();
  await health.readiness();
  assert.equal(calls, 1);
  t += 2001;
  ok = false;
  await health.readiness();
  assert.equal(calls, 2);
  t += 300; // inside the 500 ms failure ttl
  await health.readiness();
  assert.equal(calls, 2);
  t += 300; // past it
  ok = true;
  const { ready } = await health.readiness();
  assert.equal(calls, 3);
  assert.equal(ready, true);
});

test('indexer probe fails when lag exceeds INDEXER_MAX_LAG_LEDGERS and passes when disabled', async () => {
  const { defaultProbes } = await import('../src/services/health.service');
  const { config } = await import('../src/config');
  const { prisma } = await import('../src/lib/prisma');
  const indexer = defaultProbes.find((p) => p.name === 'indexer')!;
  const signal = new AbortController().signal;
  const ctx = (latestLedger: number) => ({
    result: async () => ({ name: 'rpc' as const, ok: true, critical: false, latencyMs: 1, checkedAt: '', detail: { latestLedger } }),
  });
  const cursors = prisma.indexerCursor as unknown as { findUnique: unknown };
  const original = cursors.findUnique;
  const enabled = config.INDEXER_ENABLED;
  try {
    config.INDEXER_ENABLED = false;
    assert.equal((await indexer.run(signal, ctx(1000))).ok, true);

    config.INDEXER_ENABLED = true;
    cursors.findUnique = async () => ({ lastLedger: 1000 - config.INDEXER_MAX_LAG_LEDGERS - 1, updatedAt: new Date() });
    const lagging = await indexer.run(signal, ctx(1000));
    assert.equal(lagging.ok, false);
    assert.equal(lagging.error, 'lagging');

    cursors.findUnique = async () => ({ lastLedger: 990, updatedAt: new Date() });
    assert.equal((await indexer.run(signal, ctx(1000))).ok, true);

    cursors.findUnique = async () => null;
    assert.equal((await indexer.run(signal, ctx(1000))).ok, true);
  } finally {
    cursors.findUnique = original;
    config.INDEXER_ENABLED = enabled;
  }
});

test('readyz returns 503 draining after startDraining()', async () => {
  const health = await service([up('database')]);
  health.startDraining();
  await withRouter(health, async (base) => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).data.status, 'draining');
  });
});

test('readyz and livez are not rate limited', async () => {
  const health = await service([up('database')]);
  await withRouter(health, async (base) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${base}/livez`)).status, 200);
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
    }
    assert.equal((await fetch(`${base}/limited`)).status, 200);
    assert.equal((await fetch(`${base}/limited`)).status, 429);
  });
});

test('/health keeps its shape and is marked deprecated', async () => {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('deprecation'), 'true');
    assert.equal((await res.json()).data.status, 'healthy');
  } finally {
    server.close();
  }
});

test('admin status requires an admin JWT', async () => {
  const { default: app } = await import('../src/app');
  const { signToken } = await import('../src/middlewares/auth.middleware');
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/v1/admin/status`)).status, 401);
    const token = signToken('u1', Keypair.random().publicKey());
    const nonAdmin = await fetch(`${base}/api/v1/admin/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nonAdmin.status, 403);
  } finally {
    server.close();
  }
});
