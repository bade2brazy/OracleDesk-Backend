import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(__dirname, '../../scripts/check-migration-compat.mjs');

function check(sql: string): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracledesk-migration-'));
  const file = path.join(dir, 'migration.sql');
  fs.writeFileSync(file, sql);
  const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('migration linter flags breaking and non-concurrent statements', () => {
  const result = check(`
    -- DROP TABLE users;  (commented out, ignored)
    DROP TABLE old_payments;
    ALTER TABLE users DROP COLUMN email;
    ALTER TABLE users ALTER COLUMN balance TYPE numeric;
    ALTER TABLE users RENAME COLUMN wallet TO address;
    ALTER TABLE users ALTER COLUMN name SET NOT NULL;
    CREATE INDEX trades_market_idx ON trades (market_id);
    CREATE UNIQUE INDEX CONCURRENTLY users_wallet_idx ON users (wallet_address);
  `);
  assert.equal(result.status, 1);
  for (const rule of ['drop-table', 'drop-column', 'alter-type', 'rename', 'set-not-null', 'non-concurrent-index']) {
    assert.match(result.output, new RegExp(rule));
  }
});

test('migration linter accepts expand/contract-safe SQL', () => {
  const result = check(`
    ALTER TABLE users ADD COLUMN display_name text;
    CREATE INDEX CONCURRENTLY users_display_name_idx ON users (display_name);
    ALTER TABLE users ADD CONSTRAINT users_display_name_not_null CHECK (display_name IS NOT NULL) NOT VALID;
  `);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output.trim(), '');
});
