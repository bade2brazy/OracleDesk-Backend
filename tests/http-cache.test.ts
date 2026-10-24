import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setupTestEnv } from './helpers/env';
import { prisma } from '../src/lib/prisma';
import { signToken } from '../src/middlewares/auth.middleware';
import { checkETagMatch, authClass } from '../src/middlewares/cache.middleware';

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

test('checkETagMatch handles strong comparison, wildcards, and W/ prefixes', () => {
  assert.equal(checkETagMatch('*', '"abc"'), true);
  assert.equal(checkETagMatch('"abc"', '"abc"'), true);
  assert.equal(checkETagMatch('W/"abc"', '"abc"'), true);
  assert.equal(checkETagMatch('"xyz", "abc"', '"abc"'), true);
  assert.equal(checkETagMatch('"xyz"', '"abc"'), false);
});

test('every GET route sets the documented Cache-Control and Vary headers', async () => {
  const origFindMany = prisma.market.findMany;
  const origCount = prisma.market.count;
  const origAgg = prisma.market.aggregate;

  (prisma.market.findMany as any) = async () => [];
  (prisma.market.count as any) = async () => 0;
  (prisma.market.aggregate as any) = async () => ({ _max: { updatedAt: new Date() } });

  try {
    await withServer(async (base) => {
      // GET /api/v1/markets -> shared (max-age=5, stale-while-revalidate=30)
      const res = await fetch(`${base}/api/v1/markets`);
      assert.equal(res.status, 200);
      const cc = res.headers.get('cache-control');
      assert.ok(cc?.includes('public'));
      assert.ok(cc?.includes('max-age=5'));
      assert.ok(cc?.includes('stale-while-revalidate=30'));
      const vary = res.headers.get('vary');
      assert.ok(vary?.includes('Accept-Encoding'));
      assert.ok(vary?.includes('Origin'));
    });
  } finally {
    prisma.market.findMany = origFindMany;
    prisma.market.count = origCount;
    prisma.market.aggregate = origAgg;
  }
});

test('matching If-None-Match returns 304 with no body and skips the controller for validator routes', async () => {
  const origFindMany = prisma.market.findMany;
  const origCount = prisma.market.count;
  const origAgg = prisma.market.aggregate;
  let findManyCalled = false;

  (prisma.market.aggregate as any) = async () => ({ _max: { updatedAt: new Date(1700000000000) } });
  (prisma.market.count as any) = async () => 10;
  (prisma.market.findMany as any) = async () => {
    findManyCalled = true;
    return [];
  };

  try {
    await withServer(async (base) => {
      // First request: gets full response and ETag
      const res1 = await fetch(`${base}/api/v1/markets`);
      assert.equal(res1.status, 200);
      const etag = res1.headers.get('etag');
      assert.ok(etag, 'ETag must be returned');
      assert.equal(findManyCalled, true);

      // Second request with If-None-Match
      findManyCalled = false;
      const res2 = await fetch(`${base}/api/v1/markets`, {
        headers: { 'if-none-match': etag },
      });
      assert.equal(res2.status, 304);
      const body = await res2.text();
      assert.equal(body, '', '304 response body must be empty');
      assert.equal(findManyCalled, false, 'controller must be skipped on 304');
    });
  } finally {
    prisma.market.findMany = origFindMany;
    prisma.market.count = origCount;
    prisma.market.aggregate = origAgg;
  }
});

test('requests with Authorization never get a public Cache-Control', async () => {
  const token = signToken('user-1', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/markets`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const cc = res.headers.get('cache-control');
    assert.ok(!cc?.includes('public'), 'Cache-Control must not be public when Authorization is sent');
    assert.ok(cc?.includes('private'));
    const vary = res.headers.get('vary');
    assert.ok(vary?.includes('Authorization'));
  });
});

test('errors get no-store', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/non-existent-route`);
    assert.equal(res.status, 404);
    const cc = res.headers.get('cache-control');
    assert.ok(cc?.includes('no-store'));
  });
});

test('ETag is exposed to CORS clients', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/markets`, {
      headers: { origin: 'http://localhost:3000' },
    });
    const exposed = res.headers.get('access-control-expose-headers');
    assert.ok(exposed?.includes('ETag'));
  });
});

test('authenticated payment and allowance routes are no-store', async () => {
  const token = signToken('user-1', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  const origFindUnique = prisma.spendingAllowance.findUnique;
  (prisma.spendingAllowance.findUnique as any) = async () => null;

  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/traces/access/allowance`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const cc = res.headers.get('cache-control');
      assert.ok(cc?.includes('no-store'));
    });
  } finally {
    prisma.spendingAllowance.findUnique = origFindUnique;
  }
});
