import { setupTestEnv } from '../helpers/env';
import { createTestDatabase } from '../helpers/db';

/**
 * Per-file bootstrap. `config` and `prisma` are built when first imported, so
 * DATABASE_URL/REDIS_URL must be set before any `src` import: call this in an
 * async before() hook, then dynamically import src modules.
 *
 * Returns null when the integration tier is skipped (see global-setup).
 */
export async function integrationEnv(label: string): Promise<{ drop(): Promise<void> } | null> {
  if (process.env.OD_INTEGRATION_SKIP || !process.env.OD_ADMIN_DATABASE_URL) return null;
  const db = await createTestDatabase(process.env.OD_ADMIN_DATABASE_URL, label);
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = process.env.OD_REDIS_URL;
  setupTestEnv();
  return db;
}

export const skipReason = () => process.env.OD_INTEGRATION_SKIP;
