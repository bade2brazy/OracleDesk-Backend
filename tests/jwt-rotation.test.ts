import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

function fakeProvider(values: Record<string, string>) {
  return { kind: 'file' as const, async load() { return values; } };
}

function requestWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` } };
}

test('a token signed with the previous key works during the grace window, then fails', async () => {
  const { initSecrets, refreshSecretsOnce } = await import('../src/config/secrets');
  const { optionalAuth } = await import('../src/middlewares/auth.middleware');

  const oldSecret = 'o'.repeat(32);
  const newSecret = 'n'.repeat(32);
  const cfg: any = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: oldSecret,
    AUTH_SIGNING_SECRET: (await import('@stellar/stellar-sdk')).Keypair.random().secret(),
    NODE_ENV: 'test',
    JWT_PREVIOUS_SECRET_GRACE_SECS: 1,
    SECRETS_PROVIDER: 'file',
  };
  await initSecrets(cfg, fakeProvider({ JWT_SECRET: oldSecret }));
  const token = jwt.sign({ userId: 'u1', walletAddress: 'G' }, oldSecret, { expiresIn: '7d' });

  await refreshSecretsOnce(cfg, fakeProvider({ JWT_SECRET: newSecret }));

  const during = requestWith(token);
  let nextCalled = false;
  optionalAuth(during, {} as any, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(during.user?.userId, 'u1', 'old token accepted during grace');

  const realNow = Date.now;
  Date.now = () => realNow() + 2_000;
  try {
    const after = requestWith(token);
    let afterNext = false;
    optionalAuth(after, {} as any, () => { afterNext = true; });
    assert.equal(afterNext, true, 'optionalAuth always calls next');
    assert.equal(after.user, undefined, 'old token rejected after grace');
  } finally {
    Date.now = realNow;
  }
});

test('an expired token is never retried against the previous key', async () => {
  const { initSecrets, refreshSecretsOnce } = await import('../src/config/secrets');
  const { optionalAuth } = await import('../src/middlewares/auth.middleware');
  const oldSecret = 'p'.repeat(32);
  const cfg: any = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: oldSecret,
    AUTH_SIGNING_SECRET: (await import('@stellar/stellar-sdk')).Keypair.random().secret(),
    NODE_ENV: 'test',
    JWT_PREVIOUS_SECRET_GRACE_SECS: 600,
    SECRETS_PROVIDER: 'file',
  };
  await initSecrets(cfg, fakeProvider({ JWT_SECRET: oldSecret }));
  const expired = jwt.sign({ userId: 'u1', walletAddress: 'G' }, oldSecret, { expiresIn: -1 });
  await refreshSecretsOnce(cfg, fakeProvider({ JWT_SECRET: 'q'.repeat(32) }));

  const req = requestWith(expired);
  optionalAuth(req, {} as any, () => undefined);
  assert.equal(req.user, undefined, 'expired stays expired even with a previous key');
});
