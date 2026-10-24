import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function setup() {
  const { prisma } = await import('../src/lib/prisma');
  const { fixtureSource, reconcile } = await import('../src/services/reconcile.service');
  const { resolutionHash } = await import('../src/lib/resolution-spec');
  const { CURSOR_ID } = await import('../src/services/indexer.service');

  const db = {
    cursor: 4_951_615 as number | null,
    events: new Map<string, any>(),
    markets: new Map<string, any>(),
    traces: [] as any[],
    payments: [] as any[],
  };

  const signer = Keypair.random().publicKey();
  const spec = { kind: 'signers', signers: [signer], threshold: 1, disputeWindow: 3600 } as const;
  db.markets.set('m0', {
    id: 'm0',
    onChainMarketId: 0n,
    question: 'Market zero?',
    status: 'ACTIVE',
    resolutionSpec: spec,
    resolutionHash: resolutionHash(spec as any).toString('hex'),
  });
  db.traces.push({ id: 't0', traceHash: 'f4b58d4ac4068163f34bd9486f0563c70873afa5f64e915ab7e85af7dee15e4e', onChainTraceId: null });

  (prisma.indexerCursor.findUnique as any) = async ({ where }: any) =>
    where.id === CURSOR_ID && db.cursor !== null ? { id: CURSOR_ID, lastLedger: db.cursor } : null;
  (prisma.indexerCursor.upsert as any) = async ({ update }: any) => {
    db.cursor = update.lastLedger;
    return { id: CURSOR_ID, lastLedger: update.lastLedger };
  };
  (prisma.chainEvent.create as any) = async ({ data }: any) => {
    db.events.set(data.id, data);
    return data;
  };
  (prisma.chainEvent.findMany as any) = async ({ where }: any) =>
    [...db.events.values()]
      .filter((event) => event.ledger >= where.ledger.gte)
      .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
  (prisma.market.findUnique as any) = async ({ where }: any) =>
    [...db.markets.values()].find((market) => market.onChainMarketId === where.onChainMarketId) ?? null;
  (prisma.market.findMany as any) = async () => [...db.markets.values()];
  (prisma.market.update as any) = async ({ where, data }: any) => Object.assign(db.markets.get(where.id), data);
  (prisma.position.updateMany as any) = async () => ({ count: 0 });
  (prisma.reasoningTrace.findFirst as any) = async ({ where }: any) =>
    db.traces.find((trace) => trace.traceHash === where.traceHash) ?? null;
  (prisma.reasoningTrace.update as any) = async ({ where, data }: any) =>
    Object.assign(db.traces.find((trace) => trace.id === where.id)!, data);
  (prisma.paymentEvent.findMany as any) = async () => db.payments;
  (prisma.paymentEvent.findUnique as any) = async ({ where }: any) =>
    db.payments.find((payment) => payment.txHash === where.txHash) ?? null;
  (prisma.$transaction as any) = async (ops: Promise<unknown>[]) => Promise.all(ops);

  const source = fixtureSource('tests/fixtures/events.json');
  return { prisma, db, source, reconcile, CURSOR_ID };
}

test('reconcile rewinds, reprojects and verifies payments and specs', async () => {
  const { prisma, db, source, reconcile } = await setup();
  db.payments.push({
    txHash: 'a'.repeat(64),
    fromAddress: 'GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF',
    status: 'CONFIRMED',
  });

  let verified = 0;
  const report = await reconcile(
    { rewindLedgers: 720, scanTransfers: false },
    {
      prisma: prisma as any,
      source,
      verifyPayment: (async () => {
        verified++;
        return { txHash: 'a'.repeat(64), from: 'G', to: 'G', amount: 5_000_000n, ledger: 1 };
      }) as any,
    },
    { maxChainEventLedger: 4_951_615, cursors: [{ id: 'x', lastLedger: 4_951_615 }] },
  );

  assert.equal(verified, 1, 'confirmed payment was re-verified');
  assert.equal(report.payments.reverified, 1);
  assert.deepEqual(report.specs, { checked: 1, missing: [], hashMismatch: [] });
  assert.ok(report.reprojected >= 1, 'stored events were reprojected');
  assert.equal(report.eventGap?.from, 4_950_895);
  assert.equal(db.markets.get('m0').status, 'RESOLVED', 'projection applied resolution');
});

test('reconcile refuses a cursor from a different network', async () => {
  const { prisma, db, source, reconcile } = await setup();
  db.cursor = null;
  await assert.rejects(
    reconcile(
      { rewindLedgers: 720, scanTransfers: false },
      { prisma: prisma as any, source, verifyPayment: (async () => ({})) as any },
      {},
    ),
    /No indexer cursor/,
  );
});

test('reconcile reports a resolution hash mismatch', async () => {
  const { prisma, db, source, reconcile } = await setup();
  db.markets.get('m0').resolutionHash = 'ff'.repeat(32);
  const report = await reconcile(
    { rewindLedgers: 720, scanTransfers: false },
    { prisma: prisma as any, source, verifyPayment: (async () => ({})) as any },
    {},
  );
  assert.deepEqual(report.specs.hashMismatch, ['m0']);
});

test('reconcile reports a missing resolution preimage', async () => {
  const { prisma, db, source, reconcile } = await setup();
  db.markets.get('m0').resolutionSpec = null;
  const report = await reconcile(
    { rewindLedgers: 720, scanTransfers: false },
    { prisma: prisma as any, source, verifyPayment: (async () => ({})) as any },
    {},
  );
  assert.deepEqual(report.specs.missing, ['m0']);
});
