import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

let dbAvailable = false;

test.before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

test.after(async () => {
  if (dbAvailable) {
    await prisma.$disconnect();
  }
});

function skipIfNoDb(t: any) {
  if (!dbAvailable) {
    t.skip('Database not available');
    return true;
  }
  return false;
}

test('markets rejects initialYesProb outside [0,1]', async (t) => {
  if (skipIfNoDb(t)) return;

  const validHash = 'aa'.repeat(32);
  await assert.rejects(
    async () => {
      await prisma.$executeRawUnsafe(`
        INSERT INTO markets (
          id, "questionHash", question, category, "initialYesProb", "currentYesProb",
          "resolutionSpec", "resolutionHash", "metaUri", "metadataUri", "seedAmountRaw",
          "minimumLiquidity", "totalLiquidity", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, '${validHash}', 'Will this fail?', 'CRYPTO', 1.5, 0.5,
          '{}', '${validHash}', 'ipfs://test', 'ipfs://test', '1000',
          10, 10, NOW()
        )
      `);
    },
    (err: any) => {
      // Postgres error 23514 is check_violation
      return err.message.includes('markets_initial_yes_prob_range') || err.message.includes('23514');
    },
  );
});

test('markets rejects confidenceInterval with lower > upper', async (t) => {
  if (skipIfNoDb(t)) return;

  const validHash = 'bb'.repeat(32);
  await assert.rejects(
    async () => {
      await prisma.$executeRawUnsafe(`
        INSERT INTO markets (
          id, "questionHash", question, category, "initialYesProb", "currentYesProb",
          "confidenceInterval", "resolutionSpec", "resolutionHash", "metaUri", "metadataUri",
          "seedAmountRaw", "minimumLiquidity", "totalLiquidity", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, '${validHash}', 'Will this fail?', 'CRYPTO', 0.5, 0.5,
          '{"lower": 0.8, "upper": 0.2}'::jsonb, '{}', '${validHash}', 'ipfs://test', 'ipfs://test',
          '1000', 10, 10, NOW()
        )
      `);
    },
    (err: any) => {
      return err.message.includes('markets_ci_shape') || err.message.includes('23514');
    },
  );
});

test('reasoning_traces rejects uppercase or 0x traceHash', async (t) => {
  if (skipIfNoDb(t)) return;

  const marketId = `test-market-${Date.now()}`;
  const validHash = 'cc'.repeat(32);
  const invalidTraceHash = '0x' + 'cc'.repeat(31);

  // Insert test market
  await prisma.$executeRawUnsafe(`
    INSERT INTO markets (
      id, "questionHash", question, category, "initialYesProb", "currentYesProb",
      "resolutionSpec", "resolutionHash", "metaUri", "metadataUri", "seedAmountRaw",
      "minimumLiquidity", "totalLiquidity", "updatedAt"
    ) VALUES (
      '${marketId}', '${validHash}', 'Trace test market', 'CRYPTO', 0.5, 0.5,
      '{}', '${validHash}', 'ipfs://test', 'ipfs://test', '1000',
      10, 10, NOW()
    )
  `);

  try {
    await assert.rejects(
      async () => {
        await prisma.$executeRawUnsafe(`
          INSERT INTO reasoning_traces (
            id, "marketId", "traceHash", "probabilityEstimate", "marketProbability",
            "sourcesCount", "modelId", "modelProvider", reasoning, "promptTokens",
            "completionTokens", "totalTokens", "confidenceInterval", "metaUri", "updatedAt"
          ) VALUES (
            gen_random_uuid()::text, '${marketId}', '${invalidTraceHash}', 0.5, 0.5,
            1, 'gemini-1.5-pro', 'google', 'reasoning', 100,
            100, 200, '{"lower": 0.4, "upper": 0.6}'::jsonb, 'ipfs://trace', NOW()
          )
        `);
      },
      (err: any) => {
        return err.message.includes('reasoning_traces_trace_hash_format') || err.message.includes('23514');
      },
    );
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM markets WHERE id = '${marketId}'`);
  }
});

test('payment_events rejects unknown status and non-digit amountRaw', async (t) => {
  if (skipIfNoDb(t)) return;

  const validHash = 'dd'.repeat(32);

  // Rejects invalid enum status
  await assert.rejects(
    async () => {
      await prisma.$executeRawUnsafe(`
        INSERT INTO payment_events (
          id, type, status, "walletAddress", "amountRaw", "txHash", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, 'DAILY_PASS'::"PaymentEventType", 'INVALID_STATUS'::"PaymentEventStatus",
          'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', '5000000', '${validHash}', NOW()
        )
      `);
    },
    (err: any) => {
      return err.message.includes('invalid input value for enum') || err.message.includes('PaymentEventStatus');
    },
  );

  // Rejects non-digit amountRaw
  await assert.rejects(
    async () => {
      await prisma.$executeRawUnsafe(`
        INSERT INTO payment_events (
          id, type, status, "walletAddress", "amountRaw", "txHash", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, 'DAILY_PASS'::"PaymentEventType", 'CONFIRMED'::"PaymentEventStatus",
          'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', '5.0 USDC', '${validHash}', NOW()
        )
      `);
    },
    (err: any) => {
      return err.message.includes('payment_events_amount_raw_digits') || err.message.includes('23514');
    },
  );
});

test('payment_events.traceId must reference an existing trace', async (t) => {
  if (skipIfNoDb(t)) return;

  const validHash = 'ee'.repeat(32);
  const nonExistentTraceId = 'non-existent-trace-id';

  await assert.rejects(
    async () => {
      await prisma.$executeRawUnsafe(`
        INSERT INTO payment_events (
          id, type, status, "walletAddress", "amountRaw", "txHash", "traceId", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, 'PER_TRACE'::"PaymentEventType", 'CONFIRMED'::"PaymentEventStatus",
          'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', '50000', '${validHash}', '${nonExistentTraceId}', NOW()
        )
      `);
    },
    (err: any) => {
      return err.message.includes('payment_events_traceId_fkey') || err.message.includes('23503');
    },
  );
});

test('deleting a market with copy trades is restricted', async (t) => {
  if (skipIfNoDb(t)) return;

  const marketId = `test-market-ct-${Date.now()}`;
  const validHash = 'ff'.repeat(32);
  const copyTradeId = `test-ct-${Date.now()}`;

  await prisma.$executeRawUnsafe(`
    INSERT INTO markets (
      id, "questionHash", question, category, "initialYesProb", "currentYesProb",
      "resolutionSpec", "resolutionHash", "metaUri", "metadataUri", "seedAmountRaw",
      "minimumLiquidity", "totalLiquidity", "updatedAt"
    ) VALUES (
      '${marketId}', '${validHash}', 'CT Market', 'CRYPTO', 0.5, 0.5,
      '{}', '${validHash}', 'ipfs://test', 'ipfs://test', '1000',
      10, 10, NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO copy_trades (
      id, "marketId", "followerWallet", "targetWallet", outcome, amount, "amountRaw",
      direction, status, "updatedAt"
    ) VALUES (
      '${copyTradeId}', '${marketId}', 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', 'YES', 10, '10000000',
      'BUY', 'PENDING'::"CopyTradeStatus", NOW()
    )
  `);

  try {
    await assert.rejects(
      async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM markets WHERE id = '${marketId}'`);
      },
      (err: any) => {
        return err.message.includes('copy_trades_marketId_fkey') || err.message.includes('23503');
      },
    );
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM copy_trades WHERE id = '${copyTradeId}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM markets WHERE id = '${marketId}'`);
  }
});

test('subscriptions txHash is unique when not null', async (t) => {
  if (skipIfNoDb(t)) return;

  const subId1 = `sub-1-${Date.now()}`;
  const subId2 = `sub-2-${Date.now()}`;
  const sharedHash = '12'.repeat(32);

  await prisma.$executeRawUnsafe(`
    INSERT INTO subscriptions (
      id, "walletAddress", type, status, "amountPaid", "txHash", "startsAt", "expiresAt", "updatedAt"
    ) VALUES (
      '${subId1}', 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', 'DAILY_PASS',
      'ACTIVE', 5.0, '${sharedHash}', NOW(), NOW() + interval '1 day', NOW()
    )
  `);

  try {
    await assert.rejects(
      async () => {
        await prisma.$executeRawUnsafe(`
          INSERT INTO subscriptions (
            id, "walletAddress", type, status, "amountPaid", "txHash", "startsAt", "expiresAt", "updatedAt"
          ) VALUES (
            '${subId2}', 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', 'DAILY_PASS',
            'ACTIVE', 5.0, '${sharedHash}', NOW(), NOW() + interval '1 day', NOW()
          )
        `);
      },
      (err: any) => {
        return err.message.includes('subscriptions_txHash_unique') || err.message.includes('23505');
      },
    );
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM subscriptions WHERE id = '${subId1}'`);
  }
});
