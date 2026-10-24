#!/usr/bin/env bash
# Post-deploy verification (#144). Read-only and idempotent.
set -uo pipefail

API_URL="${API_URL:-http://localhost:3000}"
READY_PATH="${READY_PATH:-/readyz}"
READY_CHECKS="${READY_CHECKS:-3}"
READY_INTERVAL="${READY_INTERVAL:-2}"
MAX_INDEXER_LAG_LEDGERS="${MAX_INDEXER_LAG_LEDGERS:-120}"
INDEXER_STATUS_URL="${INDEXER_STATUS_URL:-}"
CURSOR_ADVANCE_CHECKS="${CURSOR_ADVANCE_CHECKS:-2}"
PROMETHEUS_URL="${PROMETHEUS_URL:-}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-}"
DEPLOYMENTS="${DEPLOYMENTS:-api indexer worker}"
DIGEST="${DIGEST:-}"
SKIP_KUBE="${SKIP_KUBE:-0}"

fail=0
ok() { echo "OK: $*"; }
bad() { echo "FAIL: $*" >&2; fail=1; }

ready=0
for ((i=1; i<=READY_CHECKS; i++)); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${API_URL}${READY_PATH}" || true)"
  if [[ "$code" == "200" ]]; then ready=$((ready+1)); else break; fi
  sleep "$READY_INTERVAL"
done
if [[ "$ready" -eq "$READY_CHECKS" ]]; then ok "readiness held ${READY_CHECKS}/${READY_CHECKS}"; else bad "readiness did not hold (${ready}/${READY_CHECKS})"; fi

if [[ "$SKIP_KUBE" != "1" && -n "$KUBE_NAMESPACE" && -n "$DIGEST" ]]; then
  for deployment in $DEPLOYMENTS; do
    image="$(kubectl -n "$KUBE_NAMESPACE" get deployment "$deployment" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
    if [[ "$image" == *"@sha256:${DIGEST}" ]]; then ok "$deployment runs digest ${DIGEST:0:12}"; else bad "$deployment image '$image' does not match digest ${DIGEST:0:12}"; fi
  done
fi

if [[ -n "$INDEXER_STATUS_URL" ]]; then
  first="$(curl -s --max-time 5 "$INDEXER_STATUS_URL" || true)"
  latest="$(echo "$first" | jq -r '.latestLedger // empty' 2>/dev/null)"
  cursor="$(echo "$first" | jq -r '.lastLedger // empty' 2>/dev/null)"
  if [[ -z "$latest" || -z "$cursor" ]]; then
    bad "indexer status missing latestLedger/lastLedger"
  else
    lag=$(( latest - cursor ))
    if (( lag <= MAX_INDEXER_LAG_LEDGERS )); then ok "indexer lag ${lag} <= ${MAX_INDEXER_LAG_LEDGERS}"; else bad "indexer lag ${lag} > ${MAX_INDEXER_LAG_LEDGERS}"; fi
    sleep "$READY_INTERVAL"
    second="$(curl -s --max-time 5 "$INDEXER_STATUS_URL" || true)"
    nextCursor="$(echo "$second" | jq -r '.lastLedger // empty' 2>/dev/null)"
    if [[ -n "$nextCursor" ]] && (( nextCursor > cursor )); then ok "indexer cursor advanced"; else bad "indexer cursor did not advance"; fi
  fi
elif [[ -n "${DATABASE_URL:-}" && -n "${INDEXER_CURSOR_ID:-}" ]]; then
  cursor="$(psql "$DATABASE_URL" -At -c "SELECT \"lastLedger\" FROM indexer_cursors WHERE id='${INDEXER_CURSOR_ID}'" 2>/dev/null || true)"
  if [[ -z "$cursor" ]]; then
    bad "indexer cursor not found"
  else
    rpc_url="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
    latest="$(curl -s --max-time 5 -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$rpc_url" | jq -r '.result.latestLedger // empty' 2>/dev/null || true)"
    if [[ -n "$latest" ]]; then
      lag=$(( latest - cursor ))
      if (( lag <= MAX_INDEXER_LAG_LEDGERS )); then ok "indexer lag ${lag} <= ${MAX_INDEXER_LAG_LEDGERS}"; else bad "indexer lag ${lag} > ${MAX_INDEXER_LAG_LEDGERS}"; fi
    else
      echo "SKIP: could not read latestLedger from ${rpc_url}"
    fi
    sleep "$READY_INTERVAL"
    nextCursor="$(psql "$DATABASE_URL" -At -c "SELECT \"lastLedger\" FROM indexer_cursors WHERE id='${INDEXER_CURSOR_ID}'" 2>/dev/null || true)"
    if [[ -n "$nextCursor" ]] && (( nextCursor > cursor )); then ok "indexer cursor advanced"; else bad "indexer cursor did not advance"; fi
  fi
else
  echo "SKIP: no INDEXER_STATUS_URL or DATABASE_URL/INDEXER_CURSOR_ID for indexer lag"
fi

if [[ -n "$PROMETHEUS_URL" ]]; then
  firing="$(curl -sG --max-time 5 "$PROMETHEUS_URL/api/v1/query" --data-urlencode 'query=ALERTS{alertstate="firing",severity="critical"}' | jq -r '.data.result | length' 2>/dev/null || echo unknown)"
  if [[ "$firing" == "0" ]]; then ok "no critical burn-rate alerts"; else bad "critical alerts firing (count=${firing})"; fi
  ratio="$(curl -sG --max-time 5 "$PROMETHEUS_URL/api/v1/query" --data-urlencode 'query=sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 0.001)' | jq -r '.data.result[0].value[1] // empty' 2>/dev/null || true)"
  if [[ -n "$ratio" ]] && awk "BEGIN{exit !($ratio < 0.05)}"; then ok "5xx ratio ${ratio} < 0.05"; else bad "5xx ratio ${ratio:-unknown} >= 0.05"; fi
fi

exit "$fail"
