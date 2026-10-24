#!/usr/bin/env bash
# Smoke test against a running backend.
#
#   API=http://localhost:8000 MARKET_ID=0 scripts/smoke.sh
#
# Uses a throwaway keypair generated on the spot (never funded, never
# submitted anywhere): it only signs the login challenge.
set -euo pipefail

API=${API:-http://localhost:8000}
MARKET_ID=${MARKET_ID:-0}
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }
need() { node -e "const j=JSON.parse(require('fs').readFileSync(0));if(!j.ok){console.error(JSON.stringify(j.error));process.exit(1)};$1"; }

step "GET /health"
curl -fsS "$API/health" | need 'console.log(j.data.status)'

step "GET /readyz"
curl -fsS "$API/readyz" | need 'console.log(j.data.status)'

step "throwaway keypair"
KEYS=$(node -e 'const {Keypair}=require("@stellar/stellar-sdk");const k=Keypair.random();console.log(k.publicKey()+" "+k.secret())')
ADDRESS=${KEYS% *}; SECRET=${KEYS#* }
echo "$ADDRESS"

step "POST /api/v1/auth/challenge"
CHALLENGE=$(curl -fsS -X POST "$API/api/v1/auth/challenge" -H 'content-type: application/json' -d "{\"address\":\"$ADDRESS\"}")
echo "$CHALLENGE" | need 'console.log("expiresAt", j.data.expiresAt)'

step "sign locally, POST /api/v1/auth/verify"
SIGNED=$(echo "$CHALLENGE" | SECRET="$SECRET" node -e '
  const {Keypair,TransactionBuilder}=require("@stellar/stellar-sdk");
  const j=JSON.parse(require("fs").readFileSync(0)).data;
  const tx=TransactionBuilder.fromXDR(j.transaction,j.networkPassphrase);
  tx.sign(Keypair.fromSecret(process.env.SECRET));
  console.log(tx.toXDR());')
VERIFY=$(curl -sS -X POST "$API/api/v1/auth/verify" -H 'content-type: application/json' -d "{\"address\":\"$ADDRESS\",\"signed\":\"$SIGNED\"}")
echo "$VERIFY" | need 'console.log("walletAddress", j.data.walletAddress, "token", j.data.token.slice(0,16)+"…")'

step "replaying the same signed challenge is rejected"
REPLAY=$(curl -sS -X POST "$API/api/v1/auth/verify" -H 'content-type: application/json' -d "{\"address\":\"$ADDRESS\",\"signed\":\"$SIGNED\"}")
echo "$REPLAY" | node -e 'const j=JSON.parse(require("fs").readFileSync(0));if(j.ok){console.error("replay accepted!");process.exit(1)};console.log(j.error.code)'

step "GET /api/v1/markets"
curl -fsS "$API/api/v1/markets?limit=5" | need 'console.log("markets:", j.meta.total)'

step "GET /api/v1/markets/on-chain/$MARKET_ID/state (live from testnet)"
curl -fsS "$API/api/v1/markets/on-chain/$MARKET_ID/state" | need 'const d=j.data;console.log("status", JSON.stringify(d.status), "yesBps", d.yesBps, "reserves", d.reserve_yes, d.reserve_no)'

printf '\nsmoke: all steps passed\n'
