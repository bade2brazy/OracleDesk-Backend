/**
 * CLI wrapper for post-restore reconciliation (#146).
 */
import 'dotenv/config';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { rpcServer } from '../src/services/stellar/clients';
import { verifyUsdcTransfer } from '../src/services/payment-verification.service';
import {
  REWIND_LEDGERS_DEFAULT,
  fixtureSource,
  reconcile,
  type BackupManifest,
} from '../src/services/reconcile.service';

interface Args {
  manifest?: string;
  out?: string;
  rewindLedgers: number;
  scanTransfers: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rewindLedgers: REWIND_LEDGERS_DEFAULT, scanTransfers: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--rewind-ledgers') args.rewindLedgers = Number(argv[++i]);
    else if (arg === '--scan-transfers') args.scanTransfers = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) throw new Error('--out <report.json> is required');
  const manifest: BackupManifest = args.manifest
    ? JSON.parse(fs.readFileSync(args.manifest, 'utf8'))
    : {};
  const source = process.env.RECONCILE_FAKE_RPC
    ? fixtureSource(process.env.RECONCILE_FAKE_RPC)
    : rpcServer;
  const prisma = new PrismaClient();
  try {
    const report = await reconcile(args, { prisma, source, verifyPayment: verifyUsdcTransfer }, manifest);
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote ${args.out}`);
    if (report.specs.missing.length || report.specs.hashMismatch.length) {
      process.exitCode = 1;
    }
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
