#!/usr/bin/env bash
# Restore a dump produced by scripts/backup.sh (#146).
#   DATABASE_URL=… scripts/restore.sh <dump> [--force]
set -euo pipefail

command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore not found" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql not found" >&2; exit 1; }
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
DUMP="${1:?usage: scripts/restore.sh <dump> [--force]}"
FORCE=0
[[ "${2:-}" == "--force" ]] && FORCE=1

if [[ "$DUMP" == *.age ]]; then
  echo "Encrypted dump: decrypt it first (age -d -i <key> -o <dump> $DUMP)" >&2
  exit 1
fi

if [[ -f "${DUMP}.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && { sha256sum -c "$(basename "$DUMP").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$DUMP").sha256"; })
else
  echo "Warning: no checksum next to $DUMP" >&2
fi

COUNT="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [[ "$COUNT" != "0" && "$FORCE" != "1" ]]; then
  echo "Target database is not empty ($COUNT public tables). Use --force to restore anyway." >&2
  exit 1
fi

pg_restore "$DATABASE_URL" --no-owner --exit-on-error --clean --if-exists "$DUMP"
npx prisma migrate deploy

MANIFEST="${DUMP%.dump}-manifest.json"
[[ "$MANIFEST" == *.age-manifest.json ]] && MANIFEST="${DUMP%.age}-manifest.json"
if [[ -f "$MANIFEST" ]]; then
  echo "--- backup manifest ---"
  cat "$MANIFEST"
fi
