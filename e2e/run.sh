#!/bin/bash
# Runs phases A (main), B (restart, same key), C (SSRF, production default) against `next start`.
set -u
cd "$(dirname "$0")/.."
S="$E2E_DIR"
PG_BASE="${E2E_PG_BASE:-postgres://postgres:postgres@localhost:5432}"
export DATABASE_URL="$PG_BASE/webdog_e2e"
export DATA_ENCRYPTION_KEY="$(cat "$S/key")"
export NODE_ENV=production BETTER_AUTH_URL=http://localhost:3100 PORT=3100
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export CONTEXT_DEV_BASE_URL=http://127.0.0.1:4010/ctx OPENAI_BASE_URL=http://127.0.0.1:4010/openai/v1
export WATCH_ERROR_THRESHOLD=2
export NODE_OPTIONS="--import $PWD/e2e/intercept.mjs"
unset CONTEXT_DEV_API_KEY OPENAI_API_KEY AI_GATEWAY_API_KEY RESEND_API_KEY RESEND_SEND_FROM_EMAIL AI_MODEL

NODE_OPTIONS= node e2e/fakes.mjs > "$S/fakes.log" 2>&1 &
FAKES=$!
start_app() {
  npx next start -p 3100 >> "$S/app.log" 2>&1 &
  APP=$!
  for i in $(seq 1 60); do curl -sf http://localhost:3100/api/health >/dev/null && return 0; sleep 1; done
  echo "app did not start"; return 1
}
stop_app() { pkill -P $APP 2>/dev/null; kill $APP 2>/dev/null; wait $APP 2>/dev/null; sleep 1; }
: > "$S/app.log"; : > "$S/app2.log"; rm -f "$S/results.json" "$S/state.json"
rc=0
# Regression phases: the limiter is on, with limits high enough for the suites' bursts.
export RATE_LIMIT_READ=5000/1m RATE_LIMIT_WRITE=5000/1m RATE_LIMIT_CREATE=5000/1m RATE_LIMIT_CHECK=5000/1m RATE_LIMIT_WEBHOOK=5000/1m
export WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts A || rc=1; }; stop_app
echo "--- restart (same key) ---"
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts B || rc=1; NODE_OPTIONS= npx tsx e2e/e2e.mts R || rc=1; }; stop_app
echo "--- restart (WEBHOOK_ALLOW_PRIVATE_ADDRESSES unset: production default) ---"
unset WEBHOOK_ALLOW_PRIVATE_ADDRESSES
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts C || rc=1; }; stop_app
echo "--- rate limits: two instances, tight limits, restart in between ---"
export WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true
export RATE_LIMIT_READ=20/1m RATE_LIMIT_WRITE=5/1m RATE_LIMIT_CREATE=3/1m,5/1d RATE_LIMIT_CHECK=3/10s,7/1d RATE_LIMIT_WEBHOOK=2/1m
start_app && { npx next start -p 3101 >> "$S/app2.log" 2>&1 & APP2=$!; for i in $(seq 1 60); do curl -sf http://localhost:3101/api/health >/dev/null && break; sleep 1; done; NODE_OPTIONS= npx tsx e2e/e2e.mts L1 || rc=1; }
stop_app
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts L2 || rc=1; }; stop_app
pkill -P $APP2 2>/dev/null; kill $APP2 2>/dev/null; wait $APP2 2>/dev/null
echo "--- webhook delivery retention ---"
export RATE_LIMIT_READ=5000/1m RATE_LIMIT_WRITE=5000/1m RATE_LIMIT_CREATE=5000/1m RATE_LIMIT_CHECK=5000/1m RATE_LIMIT_WEBHOOK=5000/1m
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts P || rc=1; }; stop_app
echo "--- Retry-After ---"
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts Y || rc=1; }; stop_app
echo "--- worker health ---"
start_app && { NODE_OPTIONS= npx tsx e2e/e2e.mts H || rc=1; }; stop_app
echo "--- worker health when the database is unreachable (separate instance) ---"
DATABASE_URL="$PG_BASE/does_not_exist_e2e" npx next start -p 3102 > "$S/app3.log" 2>&1 & APP3=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:3102/api/health && break; sleep 1; done
W=$(curl -s -w ' %{http_code}' http://localhost:3102/api/health/worker); H=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3102/api/health)
if [ "$W" = '{"status":"unknown"} 503' ] && [ "$H" = "503" ]; then echo "PASS [H2] database unreachable: worker health → 503 {\"status\":\"unknown\"} with no details"; else echo "FAIL [H2] db unreachable: worker=$W web=$H"; rc=1; fi
pkill -P $APP3 2>/dev/null; kill $APP3 2>/dev/null; wait $APP3 2>/dev/null
echo "--- outbox uses the database clock (app clock 5s behind) ---"
NODE_OPTIONS= npx tsx e2e/clock-test.mts && echo "PASS [K] immediate send claims a just-queued delivery despite app clock skew" || { echo "FAIL [K] clock skew"; rc=1; }
kill $FAKES 2>/dev/null
exit $rc
