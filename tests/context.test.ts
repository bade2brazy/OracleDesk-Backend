import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function withServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('generates a request id and echoes it in X-Request-Id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.match(res.headers.get('x-request-id') ?? '', /^req_[0-9a-f-]{36}$/);
  });
});

test('accepts a well-formed inbound X-Request-Id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'client-abc_123:4' } });
    assert.equal(res.headers.get('x-request-id'), 'client-abc_123:4');
  });
});

test('rejects malformed inbound ids', async () => {
  const { acceptInboundId } = await import('../src/lib/context');
  assert.equal(acceptInboundId('short'), undefined);
  assert.equal(acceptInboundId('a'.repeat(65)), undefined);
  assert.equal(acceptInboundId('valid-id-1\nforged line'), undefined);
  assert.equal(acceptInboundId(undefined), undefined);
  assert.equal(acceptInboundId('valid-id-1'), 'valid-id-1');
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'x'.repeat(65) } });
    assert.match(res.headers.get('x-request-id') ?? '', /^req_/);
  });
});

test('error envelope includes requestId for 404s and AppErrors', async () => {
  await withServer(async (base) => {
    const notFound = await fetch(`${base}/nope`, { headers: { 'x-request-id': 'client-id-0001' } });
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error.requestId, 'client-id-0001');
    const unauth = await fetch(`${base}/api/v1/admin/trace-audit`);
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).error.requestId, unauth.headers.get('x-request-id'));
  });
});

test('body-parser errors still carry a request id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/markets/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.ok(res.headers.get('x-request-id'));
  });
});

test('X-Request-Id is listed in Access-Control-Expose-Headers for allowed origins', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`, { headers: { origin: 'http://localhost:3000' } });
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /X-Request-Id/i);
  });
});

test('log lines inside a context include the correlation ids', async () => {
  const { runWithContext, correlation, currentContext } = await import('../src/lib/context');
  const lines: string[] = [];
  const dest = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  const log = pino({
    mixin() {
      const ctx = currentContext();
      return ctx ? { ...correlation(), kind: ctx.kind } : {};
    },
  }, dest);
  runWithContext({ requestId: 'req_test', cycleId: 'cyc_test', kind: 'cron' }, () => log.info('inside'));
  log.info('outside');
  const [inside, outside] = lines.map((l) => JSON.parse(l));
  assert.equal(inside.requestId, 'req_test');
  assert.equal(inside.cycleId, 'cyc_test');
  assert.equal(inside.kind, 'cron');
  assert.equal(outside.requestId, undefined);
});

test('context survives awaited calls, timers and Promise.all', async () => {
  const { runWithContext, currentContext } = await import('../src/lib/context');
  await runWithContext({ requestId: 'req_async', kind: 'http' }, async () => {
    await sleep(5);
    assert.equal(currentContext()?.requestId, 'req_async');
    const ids = await Promise.all([1, 2, 3].map(async (n) => { await sleep(n); return currentContext()?.requestId; }));
    assert.deepEqual(ids, ['req_async', 'req_async', 'req_async']);
    const fromTimer = await new Promise((resolve) => setTimeout(() => resolve(currentContext()?.requestId), 1));
    assert.equal(fromTimer, 'req_async');
  });
});

test('bindDetached keeps requestId and adds jobId after the request context has ended', async () => {
  const { runWithContext, bindDetached, currentContext } = await import('../src/lib/context');
  let seen: { requestId?: string; jobId?: string; kind?: string } = {};
  let task: Promise<void> = Promise.resolve();
  runWithContext({ requestId: 'req_origin', kind: 'http' }, () => {
    task = bindDetached(async () => {
      await sleep(10);
      const c = currentContext();
      seen = { requestId: c?.requestId, jobId: c?.jobId, kind: c?.kind };
    }, { jobId: 'job_1' });
  });
  assert.equal(currentContext(), undefined);
  await task;
  assert.deepEqual(seen, { requestId: 'req_origin', jobId: 'job_1', kind: 'job' });
});

test('each context gets its own store, so userId does not leak between requests', async () => {
  const { runWithContext, currentContext } = await import('../src/lib/context');
  runWithContext({ requestId: 'req_a', kind: 'http' }, () => { currentContext()!.userId = 'u1'; });
  runWithContext({ requestId: 'req_b', kind: 'http' }, () => assert.equal(currentContext()!.userId, undefined));
});

test('AgentLog writes include data.correlation', async () => {
  const { writeAgentLog } = await import('../src/lib/agent-log');
  const { runWithContext } = await import('../src/lib/context');
  const created: any[] = [];
  const db = { agentLog: { create: async (args: any) => { created.push(args); return args.data; } } };
  await runWithContext({ requestId: 'req_log', cycleId: 'cyc_log', kind: 'cron' }, () =>
    writeAgentLog({ agentType: 'TRADER', level: 'INFO', action: 'TEST', data: { a: 1 } }, db as any));
  assert.deepEqual(created[0].data.data, { a: 1, correlation: { requestId: 'req_log', cycleId: 'cyc_log' } });
  await writeAgentLog({ agentType: 'TRADER', level: 'INFO', action: 'TEST' }, db as any);
  assert.deepEqual(created[1].data.data, { correlation: {} });
});

test('no direct prisma.agentLog.create calls outside the helper', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  const root = join(__dirname, '..', '..', 'src');
  const offenders = walk(root).filter((f) => !f.endsWith('agent-log.ts') && /prisma\.agentLog\s*\.create\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
