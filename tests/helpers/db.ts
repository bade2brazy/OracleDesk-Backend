import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';

export const TEMPLATE_DB = 'od_template';

function withDatabase(url: string, database: string, params = ''): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (params) u.search = params;
  return u.toString();
}

async function admin<T>(adminUrl: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Runs `prisma migrate deploy` against `url`. */
export function migrate(url: string): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/**
 * Creates and migrates the template database once (global setup). Cloning it
 * per file is much faster than migrating each time. The migration connection
 * is closed before returning, because CREATE DATABASE ... TEMPLATE fails while
 * any session is connected to the template.
 */
export async function createTemplate(adminUrl: string): Promise<void> {
  await admin(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  });
  migrate(withDatabase(adminUrl, TEMPLATE_DB));
}

/** A fresh database for one test file, cloned from the migrated template. */
export async function createTestDatabase(
  adminUrl: string,
  label: string,
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `od_test_${label.replace(/\W/g, '_')}_${process.pid}_${randomBytes(3).toString('hex')}`;
  await admin(adminUrl, (c) => c.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`));
  return {
    // Small pool: several files run in parallel against one Postgres.
    url: withDatabase(adminUrl, name, '?connection_limit=5'),
    drop: () => admin(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined),
  };
}

/** Empties every application table between tests. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
