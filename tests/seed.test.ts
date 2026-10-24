import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Contract, xdr } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

test('seed scenario is deterministic and internally consistent', async () => {
  const { buildSeedData } = await import('../src/seed/scenario');
  const { canonicalBytes, sha256Hex } = await import('../src/utils/hash.util');
  const { questionDocument } = await import('../src/services/market-chain.service');
  const { resolutionHash } = await import('../src/lib/resolution-spec');
  const { cidForBytes } = await import('../src/services/ipfs.service');

  const a = buildSeedData({ seed: 42, marketCount: 20 });
  const b = buildSeedData({ seed: 42, marketCount: 20 });
  assert.deepEqual(a, b, 'same seed produces the same bytes');
  assert.equal(a.markets.length, 20);
  assert.equal(a.users.length, 12);
  assert.ok(a.trades.length > 0, 'active markets have trades');
  assert.ok(a.chainEvents.length > 0);

  for (const market of a.markets) {
    const docBytes = canonicalBytes(questionDocument(market as any, market.resolutionHash));
    assert.equal(market.questionHash, sha256Hex(docBytes), `${market.id} question hash matches its bytes`);
    assert.equal(market.metaUri, `ipfs://${cidForBytes(docBytes)}`);
    assert.equal(resolutionHash(market.resolutionSpec).toString('hex'), market.resolutionHash);
  }

  const trace = a.traces[0];
  const payload: Record<string, unknown> = {
    agentType: trace.agentType,
    decisionType: trace.decisionType,
    marketId: trace.marketId,
    sourcesUsed: trace.sourcesUsed,
    probabilityEstimate: trace.probabilityEstimate,
    marketProbability: trace.marketProbability,
    edge: trace.edge,
    confidenceInterval: trace.confidenceInterval,
    ...(trace.agentType === 'TRADER'
      ? { betFraction: trace.betFraction ?? undefined, betSizeUsdc: trace.betSizeUsdc ?? undefined }
      : {}),
    hedgeConditions: trace.hedgeConditions,
    agentWallet: trace.agentWallet,
    timestamp: trace.createdAt.toISOString(),
    traceId: trace.id,
  };
  const bytes = canonicalBytes(payload);
  assert.equal(trace.traceHash, sha256Hex(bytes), 'trace hash commits to the pinned payload');
  assert.equal(trace.ipfsCid, cidForBytes(bytes));
});

test('transcripts encode into raw getEvents responses that the indexer decodes', async () => {
  const { buildSeedData } = await import('../src/seed/scenario');
  const { encodeSeedEvents } = await import('../src/seed/raw-events');
  const { decodeEvent } = await import('../src/services/indexer.service');

  const data = buildSeedData({ seed: 7, marketCount: 6 });
  const fixture = encodeSeedEvents(data.chainEvents);
  const decoded = fixture.events.map((event: any) =>
    decodeEvent({
      ...event,
      contractId: new Contract(event.contractId),
      topic: event.topic.map((topic: string) => xdr.ScVal.fromXDR(topic, 'base64')),
      value: xdr.ScVal.fromXDR(event.value, 'base64'),
    } as any),
  );
  assert.equal(decoded.length, data.chainEvents.length);
  for (const event of decoded) {
    assert.ok(event, 'every encoded event decodes with the contract spec');
  }
  const names = decoded.map((event) => event!.eventName);
  assert.ok(names.includes('Trade'));
  assert.ok(names.includes('MarketCreated'));
  assert.ok(names.includes('MarketResolved'));
  assert.ok(names.includes('TracePublished'));
});

test('local IPFS stub stores and fetches the exact bytes under the CID', async () => {
  const { localIpfsTransport, cidForBytes } = await import('../src/services/ipfs.service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracledesk-ipfs-'));
  const transport = localIpfsTransport(dir);
  const bytes = Buffer.from('{"hello":"world"}');
  const cid = await transport.pin(bytes, 'test');
  assert.equal(cid, cidForBytes(bytes));
  assert.deepEqual(await transport.fetch(cid), bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('snapshot anonymisation is fail-closed and deterministic', async () => {
  const { RULES, anonymizeRow, assertNoSecrets, buildWalletMap, SnapshotExportError } = await import('../src/lib/snapshot');
  const { buildSeedData } = await import('../src/seed/scenario');
  const data = buildSeedData({ seed: 11, marketCount: 5 });
  const salt = 'test-salt';
  const wallets = buildWalletMap(salt, data.users);
  const user = anonymizeRow('user', data.users[0], wallets, salt);
  const again = anonymizeRow('user', data.users[0], wallets, salt);
  assert.equal(user.walletAddress, again.walletAddress, 'pseudonym is stable');
  assert.notEqual(user.walletAddress, data.users[0].walletAddress);
  assert.equal(user.email, null);

  const payment = anonymizeRow('paymentEvent', data.paymentEvents[0], wallets, salt);
  assert.notEqual(payment.txHash, data.paymentEvents[0].txHash, 'hashes are keyed');
  assert.equal(payment.fromAddress, user.walletAddress);

  assert.throws(
    () => anonymizeRow('user', { ...data.users[0], unexpectedColumn: 'leak' }, wallets, salt),
    SnapshotExportError,
    'an unmapped column stops the export',
  );
  assert.ok(RULES.user);
  assert.throws(() => assertNoSecrets('S' + 'A'.repeat(55), salt), /secret-looking/);
  assert.throws(() => assertNoSecrets(`salt:${salt}`, salt), /secret-looking/);
});
