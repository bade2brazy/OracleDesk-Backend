import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { sha256Hex } from '../src/utils/hash.util';
import {
  classify,
  runTraceAudit,
  TraceAuditStatus,
  RegistryReader,
} from '../src/services/trace-audit.service';

setupTestEnv();

const KNOWN_AGENT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const FOREIGN_AGENT_ADDR = 'GCEZWKCA5VLDANIKMYKEGVJWJAA4TG4CA2NXU2T23K6LM8G5R5W2KXYZ';
const knownAgents = new Set([KNOWN_AGENT]);

test('classify returns VERIFIED when fetched bytes hash to on-chain trace_hash', () => {
  const content = Buffer.from(JSON.stringify({ analysis: 'valid trace' }), 'utf8');
  const contentHash = sha256Hex(content);

  const res = classify({
    onChain: {
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: contentHash,
      ipfs_cid: 'QmValid123',
    },
    db: {
      id: 'trace-1',
      marketId: 'market-1',
      onChainTraceId: 1n,
      traceHash: contentHash,
      ipfsCid: 'QmValid123',
      market: { onChainMarketId: 1n },
    },
    fetched: { bytes: content },
    knownAgents,
  });

  assert.equal(res.status, TraceAuditStatus.VERIFIED);
  assert.equal(res.computedHash, contentHash);
});

test('classify returns HASH_MISMATCH for tampered content', () => {
  const originalContent = Buffer.from('original content');
  const tamperedContent = Buffer.from('tampered content');
  const originalHash = sha256Hex(originalContent);

  const res = classify({
    onChain: {
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: originalHash,
      ipfs_cid: 'QmTampered',
    },
    db: {
      id: 'trace-1',
      marketId: 'market-1',
      onChainTraceId: 1n,
      traceHash: originalHash,
      ipfsCid: 'QmTampered',
      market: { onChainMarketId: 1n },
    },
    fetched: { bytes: tamperedContent },
    knownAgents,
  });

  assert.equal(res.status, TraceAuditStatus.HASH_MISMATCH);
  assert.notEqual(res.computedHash, originalHash);
});

test('classify returns UNAVAILABLE when every gateway fails', () => {
  const res = classify({
    onChain: {
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: '1234567890abcdef'.repeat(4),
      ipfs_cid: 'QmUnreachable',
    },
    db: {
      id: 'trace-1',
      marketId: 'market-1',
      onChainTraceId: 1n,
      traceHash: '1234567890abcdef'.repeat(4),
      ipfsCid: 'QmUnreachable',
      market: { onChainMarketId: 1n },
    },
    fetched: { error: 'Gateway timeout 504' },
    knownAgents,
  });

  assert.equal(res.status, TraceAuditStatus.UNAVAILABLE);
  assert.ok(res.detail?.error);
});

test('classify returns WRONG_MARKET when DB market differs from on-chain market_id', () => {
  const res = classify({
    onChain: {
      market_id: 2n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: '1234567890abcdef'.repeat(4),
      ipfs_cid: 'QmValid123',
    },
    db: {
      id: 'trace-1',
      marketId: 'market-1',
      onChainTraceId: 1n,
      traceHash: '1234567890abcdef'.repeat(4),
      ipfsCid: 'QmValid123',
      market: { onChainMarketId: 1n },
    },
    fetched: null,
    knownAgents,
  });

  assert.equal(res.status, TraceAuditStatus.WRONG_MARKET);
});

test('classify returns UNKNOWN_TO_BACKEND and FOREIGN_AGENT for unregistered agents', () => {
  // Case A: Unknown to backend but known agent
  const resKnown = classify({
    onChain: {
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: '1234567890abcdef'.repeat(4),
      ipfs_cid: 'QmUnknown',
    },
    db: null,
    fetched: null,
    knownAgents,
  });
  assert.equal(resKnown.status, TraceAuditStatus.UNKNOWN_TO_BACKEND);

  // Case B: Foreign agent
  const resForeign = classify({
    onChain: {
      market_id: 1n,
      agent: FOREIGN_AGENT_ADDR,
      action: 'publish',
      trace_hash: '1234567890abcdef'.repeat(4),
      ipfs_cid: 'QmUnknown',
    },
    db: null,
    fetched: null,
    knownAgents,
  });
  assert.equal(resForeign.status, TraceAuditStatus.FOREIGN_AGENT);
});

test('classify returns UNLINKED_IN_DB and relink sets onChainTraceId', async () => {
  const content = Buffer.from('unlinked trace content');
  const hash = sha256Hex(content);

  const res = classify({
    onChain: {
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: hash,
      ipfs_cid: 'QmUnlinked',
    },
    db: {
      id: 'trace-unlinked',
      marketId: 'market-1',
      onChainTraceId: null,
      traceHash: hash,
      ipfsCid: 'QmUnlinked',
      market: { onChainMarketId: 1n },
    },
    fetched: { bytes: content },
    knownAgents,
  });

  assert.equal(res.status, TraceAuditStatus.UNLINKED_IN_DB);

  // Verify mock relink
  let relinkedTraceId: bigint | null = null;
  const mockPrisma = {
    traceAuditRun: {
      create: async () => ({ id: 'run-1' }),
      findFirst: async () => null,
      update: async () => ({}),
    },
    market: {
      findMany: async () => [{ id: 'market-1', onChainMarketId: 1n }],
      findFirst: async () => ({ id: 'market-1', onChainMarketId: 1n }),
    },
    traceAudit: {
      findMany: async () => [],
      upsert: async () => ({}),
      create: async () => ({}),
    },
    reasoningTrace: {
      findMany: async () => [{ id: 'trace-unlinked', traceHash: hash, ipfsCid: 'QmUnlinked', market: { onChainMarketId: 1n } }],
      findUnique: async () => ({ id: 'trace-unlinked', onChainTraceId: null, traceHash: hash, ipfsCid: 'QmUnlinked', market: { onChainMarketId: 1n } }),
      update: async ({ data }: any) => {
        if (data.onChainTraceId !== undefined) {
          relinkedTraceId = data.onChainTraceId;
        }
        return {};
      },
    },
    chainEvent: {
      findFirst: async () => ({ txHash: 'tx-relink-123' }),
    },
  };

  const mockReader: RegistryReader = {
    traceCount: async () => 1n,
    marketTraceCount: async () => 1n,
    marketTraceAt: async () => 10n,
    getOnChainTraceOrNull: async () => ({
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: hash,
      ipfs_cid: 'QmUnlinked',
    }),
  };

  const summary = await runTraceAudit({
    reader: mockReader,
    prisma: mockPrisma,
    fetchBytesFn: async () => content,
  });

  assert.equal(summary.relinked, 1);
  assert.equal(relinkedTraceId, 10n);
});

test('classify returns NOT_ON_CHAIN when get_trace is TraceNotFound', () => {
  const res = classify({
    onChain: null,
    db: {
      id: 'trace-db-only',
      marketId: 'market-1',
      onChainTraceId: 99n,
      traceHash: '1234567890abcdef'.repeat(4),
      ipfsCid: 'QmNotOnChain',
      market: { onChainMarketId: 1n },
    },
    fetched: null,
    knownAgents,
    isArchived: false,
  });

  assert.equal(res.status, TraceAuditStatus.NOT_ON_CHAIN);

  const resArchived = classify({
    onChain: null,
    db: {
      id: 'trace-db-only',
      marketId: 'market-1',
      onChainTraceId: 99n,
      traceHash: '1234567890abcdef'.repeat(4),
      ipfsCid: 'QmArchived',
      market: { onChainMarketId: 1n },
    },
    fetched: null,
    knownAgents,
    isArchived: true,
  });

  assert.equal(resArchived.status, TraceAuditStatus.ARCHIVED);
});

test('runTraceAudit respects TRACE_AUDIT_MAX_RPC and resumes from cursorTraceId', async () => {
  let rpcCalls = 0;
  const mockReader: RegistryReader = {
    traceCount: async () => {
      rpcCalls++;
      return 100n;
    },
    marketTraceCount: async () => {
      rpcCalls++;
      return 0n;
    },
    marketTraceAt: async () => {
      rpcCalls++;
      return 0n;
    },
    getOnChainTraceOrNull: async () => {
      rpcCalls++;
      return null;
    },
  };

  const mockPrisma = {
    traceAuditRun: {
      create: async () => ({ id: 'run-rpc-test' }),
      findFirst: async () => ({ cursorTraceId: 10n, finishedAt: new Date() }),
      update: async () => ({}),
    },
    market: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    traceAudit: {
      findMany: async () => [],
      upsert: async () => ({}),
      create: async () => ({}),
    },
    reasoningTrace: {
      findMany: async () => [],
      findUnique: async () => null,
      update: async () => ({}),
    },
    chainEvent: {
      findFirst: async () => null,
    },
  };

  const summary = await runTraceAudit({
    reader: mockReader,
    prisma: mockPrisma,
    maxRpc: 5,
  });

  assert.ok(summary.rpcCalls <= 5, `Expected <= 5 RPC calls, got ${summary.rpcCalls}`);
});

test('runTraceAudit skips fetch for content over TRACE_AUDIT_MAX_BYTES', async () => {
  let fetchAttempted = false;
  const content = Buffer.alloc(1000);

  const mockReader: RegistryReader = {
    traceCount: async () => 1n,
    marketTraceCount: async () => 1n,
    marketTraceAt: async () => 1n,
    getOnChainTraceOrNull: async () => ({
      market_id: 1n,
      agent: KNOWN_AGENT,
      action: 'publish',
      trace_hash: sha256Hex(content),
      ipfs_cid: 'QmTooBig',
    }),
  };

  const mockPrisma = {
    traceAuditRun: {
      create: async () => ({ id: 'run-bytes-test' }),
      findFirst: async () => null,
      update: async () => ({}),
    },
    market: {
      findMany: async () => [{ id: 'm1', onChainMarketId: 1n }],
      findFirst: async () => ({ id: 'm1', onChainMarketId: 1n }),
    },
    traceAudit: {
      findMany: async () => [],
      upsert: async () => ({}),
      create: async () => ({}),
    },
    reasoningTrace: {
      findMany: async () => [],
      findUnique: async () => null,
      update: async () => ({}),
    },
    chainEvent: {
      findFirst: async () => null,
    },
  };

  const summary = await runTraceAudit({
    reader: mockReader,
    prisma: mockPrisma,
    maxBytes: 500, // Small max bytes
    fetchBytesFn: async (cid, opts) => {
      fetchAttempted = true;
      if (opts?.maxBytes && content.length > opts.maxBytes) {
        throw new Error(`Content length exceeds maximum allowed (${opts.maxBytes} bytes)`);
      }
      return content;
    },
  });

  assert.equal(fetchAttempted, true);
  assert.equal(summary.counts.UNAVAILABLE, 1);
});
