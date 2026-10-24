import { Keypair } from '@stellar/stellar-sdk';
import { SECRET_NAMES, setSecretsForTest } from '../../src/config/secrets';

export function setupTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
  process.env.JWT_SECRET = process.env.JWT_SECRET || '01234567890123456789012345678901';
  // Throwaway key generated for tests only; never funded, never used on-chain.
  process.env.AUTH_SIGNING_SECRET = process.env.AUTH_SIGNING_SECRET || Keypair.random().secret();
  process.env.AUTH_HOME_DOMAIN = 'localhost';
  process.env.CHAIN_EXECUTION_MODE = 'dry-run';
  process.env.AGENT_SECRET_KEY = '';
  process.env.STELLAR_RPC_URL = 'http://127.0.0.1:1'; // tests must never reach a real RPC
  process.env.INDEXER_ENABLED = 'false';
  process.env.ADMIN_ADDRESSES = '';

  // #145 — consumers read through the secret store; tests must not require a
  // running bootstrap() to seed it.
  setSecretsForTest(
    Object.fromEntries(SECRET_NAMES.map((name) => [name, process.env[name] ?? ''])) as Record<
      (typeof SECRET_NAMES)[number],
      string
    >,
  );
}
