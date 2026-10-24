import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import {
  clientIp,
  isAllowedOrigin,
  memoryConnectionLimiter,
  inboundEventLimiter,
  socketMetrics,
  normalizeIp,
  ipMatchesCidr,
} from '../src/lib/socket-limits';

setupTestEnv();

test('clientIp ignores X-Forwarded-For from untrusted peers and honours trusted proxies', () => {
  const trustedProxies = ['10.0.0.1', '127.0.0.1'];

  // Untrusted peer attempting to spoof XFF
  const untrustedReq: any = {
    socket: { remoteAddress: '198.51.100.25' },
    headers: { 'x-forwarded-for': '203.0.113.195' },
  };
  assert.equal(clientIp(untrustedReq, trustedProxies), '198.51.100.25');

  // Trusted proxy forwarding real client IP
  const trustedReq: any = {
    socket: { remoteAddress: '10.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' },
  };
  assert.equal(clientIp(trustedReq, trustedProxies), '203.0.113.50');

  // IPv6 mapped IPv4 address
  const ipv6Req: any = {
    socket: { remoteAddress: '::ffff:192.168.1.10' },
    headers: {},
  };
  assert.equal(clientIp(ipv6Req, trustedProxies), '192.168.1.10');
});

test('isAllowedOrigin allows configured origins and non-browser requests', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('http://evil.com'), false);
});

test('21st connection from one IP is rejected with CONNECTION_LIMIT PER_IP', async () => {
  const limiter = memoryConnectionLimiter({
    maxConnections: 100,
    maxPerIp: 20,
    connectRatePerMin: 100,
  });

  const ip = '1.2.3.4';
  for (let i = 1; i <= 20; i++) {
    const res = await limiter.acquire(ip, `sock-${i}`);
    assert.equal(res.ok, true);
  }

  const rejected = await limiter.acquire(ip, 'sock-21');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, 'PER_IP');
  }

  // Release one connection and verify next acquire succeeds
  await limiter.release(ip, 'sock-1');
  const allowed = await limiter.acquire(ip, 'sock-21');
  assert.equal(allowed.ok, true);
});

test('global cap rejects new connections and recovers after disconnects', async () => {
  const limiter = memoryConnectionLimiter({
    maxConnections: 3,
    maxPerIp: 10,
    connectRatePerMin: 100,
  });

  assert.equal((await limiter.acquire('1.1.1.1', 's1')).ok, true);
  assert.equal((await limiter.acquire('2.2.2.2', 's2')).ok, true);
  assert.equal((await limiter.acquire('3.3.3.3', 's3')).ok, true);

  const overflow = await limiter.acquire('4.4.4.4', 's4');
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.equal(overflow.reason, 'GLOBAL');
  }

  await limiter.release('1.1.1.1', 's1');
  assert.equal((await limiter.acquire('4.4.4.4', 's4')).ok, true);
});

test('connection rate limit rejects rapid reconnect loops', async () => {
  const limiter = memoryConnectionLimiter({
    maxConnections: 100,
    maxPerIp: 50,
    connectRatePerMin: 5,
  });

  const ip = '9.9.9.9';
  for (let i = 0; i < 5; i++) {
    const res = await limiter.acquire(ip, `s-${i}`);
    assert.equal(res.ok, true);
    await limiter.release(ip, `s-${i}`);
  }

  // 6th acquire within same minute
  const res = await limiter.acquire(ip, 's-6');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'RATE');
  }
});

test('unknown inbound events are rejected and repeated violations disconnect the socket', () => {
  let disconnected = false;
  const handlers: Array<([event, ...args]: any[], next: (err?: Error) => void) => void> = [];

  const fakeSocket: any = {
    id: 'abuse-sock',
    use: (fn: any) => handlers.push(fn),
    disconnect: () => { disconnected = true; },
  };

  inboundEventLimiter(fakeSocket, {
    allowedEvents: ['ping'],
    eventsPer10s: 20,
  });

  const runEvent = (event: string) => {
    let passed = false;
    let error: any = null;
    for (const h of handlers) {
      h([event], (err) => {
        if (err) error = err;
        else passed = true;
      });
    }
    return { passed, error };
  };

  // 1st unknown event
  const r1 = runEvent('malicious_event_1');
  assert.ok(r1.error);
  assert.equal(disconnected, false);

  // 2nd unknown event
  const r2 = runEvent('malicious_event_2');
  assert.ok(r2.error);
  assert.equal(disconnected, false);

  // 3rd unknown event -> disconnect
  runEvent('malicious_event_3');
  assert.equal(disconnected, true);
});
