/**
 * CLI wrapper for the anonymised NDJSON snapshot exporter (#147).
 * Pure rules live in src/lib/snapshot.ts so they can be unit tested.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { EXCLUDED_TABLES, RULES, assertNoSecrets, anonymizeRow, buildWalletMap, jsonSafe, SnapshotExportError } from '../src/lib/snapshot';

interface Args {
  out: string;
  tables: string[];
  limitPerTable?: number;
}

function parseArgs(argv: string[]): Args {
  let out = '';
  const tables: string[] = [];
  let limitPerTable: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out = argv[++i] ?? '';
    else if (arg === '--tables') tables.push(...(argv[++i] ?? '').split(',').map((t) => t.trim()).filter(Boolean));
    else if (arg === '--limit-per-table') limitPerTable = Number(argv[++i]);
  }
  if (!out) throw new SnapshotExportError('--out <dir> is required');
  return { out, tables, limitPerTable };
}

export async function exportSnapshot(prisma: PrismaClient, args: Args, salt: string): Promise<string[]> {
  const excluded = args.tables.filter((table) => (EXCLUDED_TABLES as readonly string[]).includes(table));
  if (excluded.length > 0) {
    throw new SnapshotExportError(`Tables are excluded from snapshots: ${excluded.join(', ')}`);
  }
  const users = await prisma.user.findMany({ take: args.limitPerTable });
  const wallets = buildWalletMap(salt, users);
  const selected = args.tables.length
    ? Object.keys(RULES).filter((model) => args.tables.includes(RULES[model].output))
    : Object.keys(RULES);
  fs.mkdirSync(args.out, { recursive: true });
  const written: string[] = [];

  for (const model of selected) {
    const rows = await (prisma as any)[model].findMany({ take: args.limitPerTable });
    const rule = RULES[model];
    const file = path.join(args.out, `${rule.output}.ndjson`);
    const lines = rows.map((row: Record<string, any>) => jsonSafe(anonymizeRow(model, row, wallets, salt)));
    const text = lines.length ? `${lines.join('\n')}\n` : '';
    assertNoSecrets(text, salt);
    fs.writeFileSync(file, text);
    written.push(file);
  }
  return written;
}

async function main(): Promise<void> {
  const salt = process.env.SNAPSHOT_SALT;
  if (!salt) throw new SnapshotExportError('SNAPSHOT_SALT is required');
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const files = await exportSnapshot(prisma, args, salt);
    console.log(`Wrote ${files.length} NDJSON files to ${args.out}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
