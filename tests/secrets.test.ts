import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: '01234567890123456789012345678901',
  AUTH_SIGNING_SECRET: Keypair.random().secret(),
  NODE_ENV: 'test',
};

test('loadConfig resolves NAME_FILE and refuses both forms', async () => {
  const { loadConfig } = await import('../src/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracledesk-secret-'));
  const file = path.join(dir, 'jwt');
  fs.writeFileSync(file, `${BASE.JWT_SECRET}\n`);

  const config = loadConfig({
    DATABASE_URL: BASE.DATABASE_URL,
    JWT_SECRET_FILE: file,
    AUTH_SIGNING_SECRET: BASE.AUTH_SIGNING_SECRET,
  });
  assert.equal(config.JWT_SECRET, BASE.JWT_SECRET, 'trailing newline is stripped');

  assert.throws(
    () => loadConfig({ DATABASE_URL: BASE.DATABASE_URL, JWT_SECRET: BASE.JWT_SECRET, JWT_SECRET_FILE: file }),
    /cannot both be set/,
  );

  const empty = path.join(dir, 'empty');
  fs.writeFileSync(empty, '\n');
  assert.throws(
    () => loadConfig({ DATABASE_URL: BASE.DATABASE_URL, JWT_SECRET_FILE: empty }),
    /JWT_SECRET_FILE is empty/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig rejects a short JWT at boot', async () => {
  const { loadConfig } = await import('../src/config');
  assert.throws(
    () => loadConfig({ ...BASE, JWT_SECRET: 'short' }),
    /JWT_SECRET must be at least 32 characters/,
  );
});

test('file provider refresh rotates JWT, keeps the previous value inside the grace window, then zeroes it', async () => {
  const { initSecrets, previousSecret, refreshSecretsOnce, secret, secretEntry } = await import('../src/config/secrets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracledesk-refresh-'));
  const file = path.join(dir, 'jwt');
  fs.writeFileSync(file, 'a'.repeat(32));
  const cfg: any = { ...BASE, JWT_SECRET: 'a'.repeat(32), SECRETS_PROVIDER: 'file', JWT_PREVIOUS_SECRET_GRACE_SECS: 60 };

  // Point the file provider at a temporary NAME_FILE, not a real mount.
  const previousEnv = process.env.JWT_SECRET_FILE;
  process.env.JWT_SECRET_FILE = file;
  try {
    const { fileProvider } = await import('../src/config/secrets');
    await initSecrets(cfg, fileProvider());
    fs.writeFileSync(file, 'b'.repeat(32));
    const result = await refreshSecretsOnce(cfg);
    assert.deepEqual(result.updated, ['JWT_SECRET']);
    assert.equal(secret('JWT_SECRET'), 'b'.repeat(32));
    assert.equal(previousSecret('JWT_SECRET'), 'a'.repeat(32), 'previous value survives the grace window');
    assert.ok(secretEntry('JWT_SECRET').version >= 2);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      assert.equal(previousSecret('JWT_SECRET'), null, 'previous value is dropped after the grace window');
      assert.equal(secretEntry('JWT_SECRET').previous, undefined);
    } finally {
      Date.now = realNow;
    }
  } finally {
    if (previousEnv === undefined) delete process.env.JWT_SECRET_FILE;
    else process.env.JWT_SECRET_FILE = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or invalid refresh does not wipe a working key', async () => {
  const { initSecrets, refreshSecretsOnce, secret } = await import('../src/config/secrets');
  const cfg: any = { ...BASE, JWT_SECRET: 'c'.repeat(32), SECRETS_PROVIDER: 'file' };
  let next = '';
  const provider = { kind: 'file' as const, async load() { return { JWT_SECRET: next }; } };

  await initSecrets(cfg, provider);
  next = '';
  let result = await refreshSecretsOnce(cfg, provider);
  assert.equal(secret('JWT_SECRET'), 'c'.repeat(32));
  assert.match(result.problems.join('\n'), /empty value/);

  next = 'short';
  result = await refreshSecretsOnce(cfg, provider);
  assert.equal(secret('JWT_SECRET'), 'c'.repeat(32));
  assert.match(result.problems.join('\n'), /failed validation/);

  next = 'd'.repeat(32);
  result = await refreshSecretsOnce(cfg, provider);
  assert.equal(secret('JWT_SECRET'), 'd'.repeat(32));
  assert.deepEqual(result.updated, ['JWT_SECRET']);
});

test('a provider failure keeps current values and never throws', async () => {
  const { initSecrets, refreshSecretsOnce, secret } = await import('../src/config/secrets');
  const cfg: any = { ...BASE, JWT_SECRET: 'e'.repeat(32), SECRETS_PROVIDER: 'file' };
  const healthy = { kind: 'file' as const, async load() { return { JWT_SECRET: 'e'.repeat(32) }; } };
  await initSecrets(cfg, healthy);
  const provider = { kind: 'file' as const, async load(): Promise<never> { throw new Error('vault down'); } };
  const result = await refreshSecretsOnce(cfg, provider);
  assert.equal(secret('JWT_SECRET'), 'e'.repeat(32));
  assert.match(result.problems.join('\n'), /provider refresh failed/);
});

test('LLM clients are rebuilt only after their key rotates', async () => {
  const { setSecretsForTest } = await import('../src/config/secrets');
  const { getGenAI } = await import('../src/lib/gemini');
  const { getAnthropicClient } = await import('../src/lib/llm');

  setSecretsForTest({ GEMINI_API_KEY: 'key-one', ANTHROPIC_API_KEY: 'anthropic-one' });
  const geminiOne = getGenAI();
  const anthropicOne = getAnthropicClient();
  assert.equal(getGenAI(), geminiOne, 'same version reuses the client');
  assert.equal(getAnthropicClient(), anthropicOne);

  setSecretsForTest({ GEMINI_API_KEY: 'key-two', ANTHROPIC_API_KEY: 'anthropic-two' });
  assert.notEqual(getGenAI(), geminiOne, 'rotation rebuilds Gemini');
  assert.notEqual(getAnthropicClient(), anthropicOne, 'rotation rebuilds Anthropic');
});
