# Backup and restore runbook

## Take a backup

```bash
DATABASE_URL=… BACKUP_DIR=./backups ./scripts/backup.sh
# encrypted with age:
DATABASE_URL=… BACKUP_DIR=./backups ./scripts/backup.sh --encrypt-to age1…
# only the critical NDJSON tables:
DATABASE_URL=… BACKUP_DIR=./backups ./scripts/backup.sh --critical-only
```

The script writes a custom-format `pg_dump`, its `.sha256`, and a
`-manifest.json` containing migrations, indexer cursor(s), the highest
`chain_events.ledger`, the newest payment timestamp and row counts. Keep
`BACKUP_KEEP_DAILY` / `BACKUP_KEEP_WEEKLY` dumps (default 7 / 4).

The optional Compose profile runs the same script every 6 hours:

```bash
docker compose --profile backup up -d backup
```

## Restore

Restore into an empty database:

```bash
DATABASE_URL=… ./scripts/restore.sh backups/oracledesk-….dump
```

The script verifies the checksum, refuses a non-empty target unless `--force`
is passed, runs `pg_restore`, then `prisma migrate deploy`. Print the manifest
to see which indexer cursor the snapshot expects.

## Reconcile after restore

Postgres is now behind the chain. Replay the ledger gap and rebuild
projections:

```bash
DATABASE_URL=… INDEXER_CURSOR_ID='stellar:Test SDF Network ; September 2015' \
  npx tsx scripts/post-restore-reconcile.ts \
    --manifest backups/oracledesk-…-manifest.json \
    --rewind-ledgers 720 --scan-transfers \
    --out reconcile-report.json
```

The report lists:

- the RPC retention gap (events that can never be replayed);
- events re-projected and newly indexed;
- CONFIRMED payments that could not be re-verified (expected once RPC
  retention drops them);
- markets with a missing `resolutionSpec` or a hash mismatch (exit 1);
- recipient transfers with no `payment_events` row (`--scan-transfers`).

A finality rewind of 720 ledgers (about an hour) is the default. Increase it
when restoring an old snapshot. The process is read-only against Stellar.

## Drill

`.github/workflows/restore-drill.yml` seeds a scratch database, backs it up,
drops the schema, restores, and reconciles against `tests/fixtures/events.json`
(`RECONCILE_FAKE_RPC`). It runs monthly and on demand.
