#!/usr/bin/env bash
# Lints new Prisma migrations (#104).
#
#   - Historical migrations are forward-only: modifying one fails.
#   - Every new migration must set a lock_timeout.
#   - New migrations are linted with a pinned squawk; exceptions come from
#     prisma/migration-allowlist.json (one migration, specific rules, a reason).
#
# Base ref: origin/$GITHUB_BASE_REF on pull requests, HEAD~1 otherwise.
set -euo pipefail

SQUAWK_VERSION="2.21.0"
ALLOWLIST="prisma/migration-allowlist.json"

if [ -n "${GITHUB_BASE_REF:-}" ]; then
  base="origin/${GITHUB_BASE_REF}"
else
  base="${MIGRATIONS_BASE_REF:-HEAD~1}"
fi
if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "Base ref $base not found; fetch full history (fetch-depth: 0)." >&2
  exit 2
fi
merge_base="$(git merge-base "$base" HEAD)"
pattern='prisma/migrations/*/migration.sql'

modified="$(git diff --name-only --diff-filter=MDR "$merge_base" HEAD -- "$pattern")"
if [ -n "$modified" ]; then
  echo "Merged migrations are forward-only; these were modified, deleted or renamed:" >&2
  echo "$modified" >&2
  exit 1
fi

added="$(git diff --name-only --diff-filter=A "$merge_base" HEAD -- "$pattern")"
if [ -z "$added" ]; then
  echo "No new migrations; nothing to lint."
  exit 0
fi

failed=0
while IFS= read -r file; do
  name="$(basename "$(dirname "$file")")"

  if ! grep -Eiq "^[[:space:]]*SET[[:space:]]+(LOCAL[[:space:]]+)?lock_timeout[[:space:]]*(=|TO)" "$file"; then
    echo "$file: missing \"SET lock_timeout = '5s';\" (a blocked migration must fail fast)." >&2
    failed=1
  fi

  # Allowlist entries must name a reason and a reviewer.
  excludes="$(MIGRATION="$name" ALLOWLIST="$ALLOWLIST" node -e '
    const entries = JSON.parse(require("fs").readFileSync(process.env.ALLOWLIST, "utf8"));
    const rules = [];
    for (const e of entries) {
      if (!e.reason || !e.approvedBy || !Array.isArray(e.rules)) {
        console.error("Invalid allowlist entry for " + e.migration + ": rules, reason and approvedBy are required.");
        process.exit(1);
      }
      if (e.migration === process.env.MIGRATION) rules.push(...e.rules);
    }
    process.stdout.write(rules.join(","));
  ')"

  args=(--assume-in-transaction)
  if [ -n "$excludes" ]; then args+=(--exclude="$excludes"); fi
  echo "Linting $file${excludes:+ (allowlisted: $excludes)}"
  if ! npx --yes "squawk-cli@${SQUAWK_VERSION}" "${args[@]}" "$file"; then
    failed=1
  fi
done <<< "$added"

exit "$failed"
