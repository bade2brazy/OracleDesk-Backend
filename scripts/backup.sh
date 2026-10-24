#!/usr/bin/env bash
# Postgres backup with a consistency manifest (#146).
#
#   DATABASE_URL=… BACKUP_DIR=./backups scripts/backup.sh [--encrypt-to <age-recipient>]
#   DATABASE_URL=… BACKUP_DIR=./backups scripts/backup.sh --critical-only
set -euo pipefail

command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump not found" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql not found" >&2; exit 1; }
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
CRITICAL_ONLY=0
ENCRYPT_TO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --critical-only) CRITICAL_ONLY=1; shift ;;
    --encrypt-to) ENCRYPT_TO="${2:?--encrypt-to needs a recipient}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BASE="oracledesk-${STAMP}-${GIT_SHA}"

write_critical() {
  local out="$1"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (SELECT row_to_json(t) FROM (SELECT id, \"onChainMarketId\", \"resolutionSpec\", \"resolutionHash\", \"questionHash\", \"metaUri\" FROM markets) t) TO '${out}/markets.ndjson' WITH (FORMAT text)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (SELECT row_to_json(t) FROM (SELECT * FROM payment_events) t) TO '${out}/payment_events.ndjson' WITH (FORMAT text)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (SELECT row_to_json(t) FROM (SELECT * FROM subscriptions) t) TO '${out}/subscriptions.ndjson' WITH (FORMAT text)"
}

write_manifest() {
  local out="$1"
  local tmp
  tmp="$(mktemp)"
  {
    echo "MIGRATIONS"
    psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at" || true
    echo "CURSORS"
    psql "$DATABASE_URL" -At -F $'\t' -v ON_ERROR_STOP=1 -c 'SELECT id, "lastLedger" FROM indexer_cursors' || true
    echo "MAXLEDGER"
    psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE(MAX(ledger),0) FROM chain_events" || echo 0
    echo "MAXPAYMENT"
    psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE(MAX(\"createdAt\")::text,'') FROM payment_events" || echo ""
    echo "COUNTS"
    psql "$DATABASE_URL" -At -F $'\t' -v ON_ERROR_STOP=1 -c "
      SELECT 'users', count(*) FROM users UNION ALL
      SELECT 'markets', count(*) FROM markets UNION ALL
      SELECT 'reasoning_traces', count(*) FROM reasoning_traces UNION ALL
      SELECT 'trades', count(*) FROM trades UNION ALL
      SELECT 'positions', count(*) FROM positions UNION ALL
      SELECT 'copy_trades', count(*) FROM copy_trades UNION ALL
      SELECT 'subscriptions', count(*) FROM subscriptions UNION ALL
      SELECT 'payment_events', count(*) FROM payment_events UNION ALL
      SELECT 'chain_events', count(*) FROM chain_events" || true
  } > "$tmp"

  node - "$tmp" "$out" "$STAMP" "$GIT_SHA" <<'NODE'
const fs = require('fs');
const [,, tmp, out, createdAt, gitSha] = process.argv;
const lines = fs.readFileSync(tmp, 'utf8').split('\n');
let section = '';
const manifest = { createdAt, gitSha, migrations: [], cursors: [], maxChainEventLedger: 0, maxPaymentEventCreatedAt: null, rowCounts: {} };
for (const line of lines) {
  if (['MIGRATIONS','CURSORS','MAXLEDGER','MAXPAYMENT','COUNTS'].includes(line)) { section = line; continue; }
  if (!line) continue;
  if (section === 'MIGRATIONS') manifest.migrations.push(line);
  else if (section === 'CURSORS') { const [id, ledger] = line.split('\t'); manifest.cursors.push({ id, lastLedger: Number(ledger) }); }
  else if (section === 'MAXLEDGER') manifest.maxChainEventLedger = Number(line);
  else if (section === 'MAXPAYMENT') manifest.maxPaymentEventCreatedAt = line || null;
  else if (section === 'COUNTS') { const [table, count] = line.split('\t'); manifest.rowCounts[table] = Number(count); }
}
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
NODE
  rm -f "$tmp"
}

if [[ "$CRITICAL_ONLY" == "1" ]]; then
  OUT="${BACKUP_DIR}/${BASE}-critical"
  mkdir -p "$OUT"
  write_critical "$OUT"
  echo "$OUT"
  exit 0
fi

DUMP="${BACKUP_DIR}/${BASE}.dump"
pg_dump "$DATABASE_URL" --format=custom --no-owner --serializable-deferrable --file "$DUMP"
if [[ -n "$ENCRYPT_TO" ]]; then
  command -v age >/dev/null 2>&1 || { echo "age is required for --encrypt-to" >&2; rm -f "$DUMP"; exit 1; }
  age -r "$ENCRYPT_TO" -o "${DUMP}.age" "$DUMP"
  rm -f "$DUMP"
  DUMP="${DUMP}.age"
fi

DUMP_DIR="$(dirname "$DUMP")"
DUMP_NAME="$(basename "$DUMP")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DUMP_DIR" && sha256sum "$DUMP_NAME" > "${DUMP_NAME}.sha256")
else
  (cd "$DUMP_DIR" && shasum -a 256 "$DUMP_NAME" > "${DUMP_NAME}.sha256")
fi
write_manifest "${BACKUP_DIR}/${BASE}-manifest.json"

# Retention: keep the newest daily/weekly counts. A simple, deterministic rule
# is enough here; the runbook documents how to tune it.
KEEP=$(( BACKUP_KEEP_DAILY > BACKUP_KEEP_WEEKLY ? BACKUP_KEEP_DAILY : BACKUP_KEEP_WEEKLY ))
i=0
while IFS= read -r old; do
  i=$((i + 1))
  if (( i > KEEP )); then rm -f "$old" "${old}.sha256"; fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'oracledesk-*.dump*' -type f ! -name '*.sha256' | sort -r)

echo "$DUMP"
