import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let auth: typeof import('../../src/services/auth.service');
let redis: Awaited<ReturnType<typeof import('../helpers/redis').withRedisPrefix>>;
let truncateAll: typeof import('../helpers/db').truncateAll;

before(async () => {
  db = await integrationEnv('auth');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  auth = await import('../../src/services/auth.service');
  truncateAll = (await import('../helpers/db')).truncateAll;
  redis = await (await import('../helpers/redis')).withRedisPrefix('auth');
  // Real Redis SET EX / GETDEL, under a per-file key prefix.
  auth.setChallengeStore(redis.store);
});
beforeEach(async () => { if (db) { await truncateAll(prisma); await redis.flushPrefix(); } });
after(async () => {
  if (!db) return;
  await redis.flushPrefix();
  await (await import('../../src/lib/redis')).closeRedis();
  await prisma.$disconnect();
  await db.drop();
});

function sign(xdr: string, passphrase: string, kp: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(kp);
  return tx.toXDR();
}
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

test('login end to end creates exactly one user across repeated logins', { skip: skipReason() }, async () => {
  const user = Keypair.random();
  for (let i = 0; i < 2; i++) {
    const ch = await auth.createChallenge(user.publicKey());
    const res = await auth.verifyChallenge(user.publicKey(), sign(ch.transaction, ch.networkPassphrase, user));
    assert.equal(res.walletAddress, user.publicKey());
  }
  assert.equal(await prisma.user.count({ where: { walletAddress: user.publicKey() } }), 1);
});

test('replay rejected', { skip: skipReason() }, async () => {
  const user = Keypair.random();
  const ch = await auth.createChallenge(user.publicKey());
  const signed = sign(ch.transaction, ch.networkPassphrase, user);
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), signed)), 'ok');
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), signed)), 'CHALLENGE_NOT_FOUND');
});

test('concurrent verify of one challenge succeeds exactly once (GETDEL atomicity)', { skip: skipReason() }, async () => {
  const user = Keypair.random();
  const ch = await auth.createChallenge(user.publicKey());
  const signed = sign(ch.transaction, ch.networkPassphrase, user);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => code(auth.verifyChallenge(user.publicKey(), signed))),
  );
  assert.equal(results.filter((r) => r === 'ok').length, 1);
  assert.equal(results.filter((r) => r === 'CHALLENGE_NOT_FOUND').length, 19);
});
