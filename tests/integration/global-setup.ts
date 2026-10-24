import { ensureContainers, type Services } from '../helpers/containers';
import { createTemplate } from '../helpers/db';

// Loaded via `node --test --test-global-setup=...` (Node >= 22.10). Runs once
// in the parent process; env vars set here are inherited by every test file.
let services: Services | null = null;

export async function globalSetup(): Promise<void> {
  services = await ensureContainers();
  if (!services) {
    process.env.OD_INTEGRATION_SKIP = 'Docker unavailable and no TEST_DATABASE_URL/TEST_REDIS_URL set';
    return;
  }
  process.env.OD_ADMIN_DATABASE_URL = services.adminDatabaseUrl;
  process.env.OD_REDIS_URL = services.redisUrl;
  await createTemplate(services.adminDatabaseUrl);
}

export async function globalTeardown(): Promise<void> {
  await services?.stop();
}
