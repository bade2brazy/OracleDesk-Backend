import crypto from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { DEPLOYED_AGENT } from '../config/contracts';

type Rule = 'keep' | 'drop' | 'null' | 'wallet' | 'hash' | 'address-map';

interface TableRule {
  output: string;
  columns: Record<string, Rule>;
}

export const RULES: Record<string, TableRule> = {
  user: {
    output: 'users',
    columns: { id: 'keep', walletAddress: 'wallet', email: 'null', createdAt: 'keep', updatedAt: 'keep' },
  },
  market: {
    output: 'markets',
    columns: {
      id: 'keep', question: 'keep', category: 'keep', status: 'keep', settlementCurrency: 'keep',
      initialYesProb: 'keep', currentYesProb: 'keep', confidenceInterval: 'keep', expiryTimestamp: 'keep',
      resolutionOracle: 'keep', resolvedOutcome: 'keep', resolvedAt: 'keep', minimumLiquidity: 'keep',
      totalLiquidity: 'keep', onChainMarketId: 'keep', creationTxHash: 'keep', seedAmountRaw: 'keep',
      questionHash: 'keep', metaUri: 'keep', resolutionHash: 'keep', resolutionSpec: 'keep',
      createdAt: 'keep', updatedAt: 'keep',
    },
  },
  reasoningTrace: {
    output: 'reasoning_traces',
    columns: {
      id: 'keep', marketId: 'keep', agentType: 'keep', decisionType: 'keep', sourcesUsed: 'keep',
      probabilityEstimate: 'keep', marketProbability: 'keep', edge: 'keep', confidenceInterval: 'keep',
      betFraction: 'keep', betSizeUsdc: 'keep', hedgeConditions: 'keep', agentWallet: 'wallet',
      signature: 'keep', ipfsCid: 'keep', traceHash: 'keep', onChainTraceId: 'keep', publishTxHash: 'keep',
      verified: 'keep', isPublic: 'keep', previewSources: 'keep', createdAt: 'keep', updatedAt: 'keep',
    },
  },
  trade: {
    output: 'trades',
    columns: {
      id: 'keep', marketId: 'keep', direction: 'keep', status: 'keep', amount: 'keep', price: 'keep',
      edgeDetected: 'keep', kellyFraction: 'keep', txHash: 'hash', builderFee: 'keep', errorMessage: 'keep',
      executedAt: 'keep', createdAt: 'keep', updatedAt: 'keep',
    },
  },
  position: {
    output: 'positions',
    columns: {
      id: 'keep', marketId: 'keep', tradeId: 'keep', direction: 'keep', status: 'keep', entryPrice: 'keep',
      currentPrice: 'keep', size: 'keep', pnl: 'keep', hedgeMarketId: 'keep', closedAt: 'keep',
      closeReason: 'keep', createdAt: 'keep', updatedAt: 'keep',
    },
  },
  copyTrade: {
    output: 'copy_trades',
    columns: {
      id: 'keep', userId: 'keep', traceId: 'keep', marketId: 'keep', tradeId: 'keep', direction: 'keep',
      amount: 'keep', amountRaw: 'keep', txHash: 'hash', builderFee: 'keep', status: 'keep', pnl: 'keep',
      createdAt: 'keep', updatedAt: 'keep',
    },
  },
  subscription: {
    output: 'subscriptions',
    columns: {
      id: 'keep', userId: 'keep', traceId: 'keep', type: 'keep', status: 'keep', amountPaid: 'keep',
      currency: 'keep', txHash: 'hash', expiresAt: 'keep', createdAt: 'keep', updatedAt: 'keep',
    },
  },
  paymentEvent: {
    output: 'payment_events',
    columns: {
      id: 'keep', userId: 'keep', txHash: 'hash', type: 'keep', amount: 'keep', amountRaw: 'keep',
      fromAddress: 'wallet', currency: 'keep', status: 'keep', traceId: 'keep', metadata: 'address-map',
      createdAt: 'keep', confirmedAt: 'keep',
    },
  },
  spendingAllowance: {
    output: 'spending_allowances',
    columns: {
      id: 'keep', userId: 'keep', dailyLimit: 'keep', perTraceLimit: 'keep', spentToday: 'keep',
      currency: 'keep', lastResetAt: 'keep', isActive: 'keep', createdAt: 'keep', updatedAt: 'keep',
    },
  },
  agentLog: {
    output: 'agent_logs',
    columns: {
      id: 'keep', agentType: 'keep', level: 'keep', action: 'keep', marketId: 'keep', data: 'drop',
      error: 'drop', createdAt: 'keep',
    },
  },
  marketGenerationJob: {
    output: 'market_generation_jobs',
    columns: {
      id: 'keep', status: 'keep', marketId: 'keep', traceId: 'keep', error: 'drop',
      startedAt: 'keep', completedAt: 'keep',
    },
  },
  chainEvent: {
    output: 'chain_events',
    columns: {
      id: 'keep', contractId: 'keep', contractName: 'keep', eventName: 'keep', ledger: 'keep',
      ledgerClosedAt: 'keep', txHash: 'keep', params: 'address-map', createdAt: 'keep',
    },
  },
  indexerCursor: {
    output: 'indexer_cursors',
    columns: { id: 'keep', lastLedger: 'keep', updatedAt: 'keep' },
  },
};

/** Tables intentionally not exported: raw ingestion payloads may contain source text. */
export const EXCLUDED_TABLES = ['signal_cache'] as const;

export class SnapshotExportError extends Error {}

export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

export function hmac(salt: string, value: string): Buffer {
  return crypto.createHmac('sha256', salt).update(value).digest();
}

export function pseudonymWallet(salt: string, address: string): string {
  return Keypair.fromRawEd25519Seed(hmac(salt, address)).publicKey();
}

export function pseudonymHash(salt: string, hash: string): string {
  return hmac(salt, hash).toString('hex');
}

export function buildWalletMap(salt: string, users: Array<{ walletAddress: string }>): Map<string, string> {
  return new Map(users.map((user) => [user.walletAddress, pseudonymWallet(salt, user.walletAddress)]));
}

function mapAddresses(value: unknown, wallets: Map<string, string>, salt: string): unknown {
  if (typeof value === 'string') {
    if (wallets.has(value)) return wallets.get(value)!;
    if (/^[0-9a-f]{64}$/i.test(value)) return pseudonymHash(salt, value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => mapAddresses(item, wallets, salt));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /^(from|to|trader|holder|agent|creator|wallet|address|walletAddress)$/i.test(key) && typeof item === 'string'
          ? mapAddresses(item, wallets, salt)
          : mapAddresses(item, wallets, salt),
      ]),
    );
  }
  return value;
}

export function anonymizeRow(
  table: string,
  row: Record<string, any>,
  wallets: Map<string, string>,
  salt: string,
): Record<string, any> {
  const rule = RULES[table];
  if (!rule) throw new SnapshotExportError(`No snapshot rule for table ${table}`);
  const out: Record<string, any> = {};
  for (const [column, value] of Object.entries(row)) {
    const action = rule.columns[column];
    if (!action) {
      throw new SnapshotExportError(`Unmapped column ${table}.${column}; add it to scripts/snapshot-export.ts`);
    }
    if (action === 'drop') continue;
    if (action === 'null') out[column] = null;
    else if (action === 'wallet') out[column] = wallets.get(value) ?? (value === DEPLOYED_AGENT ? value : pseudonymWallet(salt, value));
    else if (action === 'hash') out[column] = typeof value === 'string' ? pseudonymHash(salt, value) : value;
    else if (action === 'address-map') out[column] = mapAddresses(value, wallets, salt);
    else out[column] = value;
  }
  return out;
}

const SECRET_PATTERNS = [
  /S[A-Z2-7]{55}/,
  /sk-ant-/,
  /AIza[0-9A-Za-z_-]{20,}/,
];

export function assertNoSecrets(text: string, salt: string): void {
  const found = [...SECRET_PATTERNS, new RegExp(salt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].some((pattern) =>
    pattern.test(text),
  );
  if (found) throw new SnapshotExportError('Snapshot output contains a secret-looking value; refusing to keep it');
}

