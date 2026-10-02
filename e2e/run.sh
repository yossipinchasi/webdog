#!/bin/bash
# End-to-end phases against `next start` (production build), the worker, and local fakes.
# Each phase restarts the app with the environment it needs; see e2e/README.md. Exits non-zero
# if any phase fails, including a server that can't be started or stopped.
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

rc=0
fail() { echo "FAIL [run] $*"; rc=1; }

# Servers are started as the `next` node process itself (not through npx, whose shell
# wrapper on Linux would leave the server running after we kill the wrapper), so the
# stored PID is the server. A server never starts on a port that is already serving,
# and stopping waits until the port is closed, so a phase can never talk to a stale
# server left over from the previous one.
serving() { curl -s -o /dev/null "http://localhost:$1/"; }
serve() { # serve <port> <log> <ready: 200|any> → SERVED_PID
  local port=$1 log=$2 ready=$3
  if serving "$port"; then echo "port $port is already serving (stale server)"; return 1; fi
  node_modules/.bin/next start -p "$port" >> "$log" 2>&1 &
  SERVED_PID=$!
  for _ in $(seq 1 60); do
    if [ "$ready" = 200 ]; then curl -sf -o /dev/null "http://localhost:$port/api/health" && return 0
    else serving "$port" && return 0; fi
    kill -0 "$SERVED_PID" 2>/dev/null || { echo "server on $port exited"; return 1; }
    sleep 1
  done
  echo "server on $port did not start"; return 1
}
unserve() { # unserve <pid> <port>
  kill "$1" 2>/dev/null; wait "$1" 2>/dev/null
  for _ in $(seq 1 50); do serving "$2" || return 0; sleep 0.2; done
  echo "server on port $2 did not stop"; return 1
}
phase() { NODE_OPTIONS= npx tsx e2e/e2e.mts "$1" || rc=1; }
app_up() { serve 3100 "$S/app.log" 200 && APP=$SERVED_PID; }
app_down() { unserve "$APP" 3100 || fail "app on 3100 did not stop"; }
# with_app <phase…>: start the app, run the phases, stop it (a failed start fails the phases).
with_app() {
  if app_up; then
    for p in "$@"; do phase "$p"; done
    app_down
  else
    fail "app did not start for phase(s) $*"
  fi
}

NODE_OPTIONS= node e2e/fakes.mjs > "$S/fakes.log" 2>&1 &
FAKES=$!
: > "$S/app.log"; : > "$S/app2.log"; : > "$S/app3.log"; rm -f "$S/results.json" "$S/state.json"

# Regression phases: the limiter is on, with limits high enough for the suites' bursts.
GENEROUS="5000/1m"
export RATE_LIMIT_READ=$GENEROUS RATE_LIMIT_WRITE=$GENEROUS RATE_LIMIT_CREATE=$GENEROUS RATE_LIMIT_CHECK=$GENEROUS RATE_LIMIT_WEBHOOK=$GENEROUS
export WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true
echo "--- A: Phases 1–3 and 4.2 ---"
with_app A
echo "--- B, R: restart with the same key; revoked API keys ---"
with_app B R

echo "--- C: SSRF with the production default (WEBHOOK_ALLOW_PRIVATE_ADDRESSES unset) ---"
unset WEBHOOK_ALLOW_PRIVATE_ADDRESSES
with_app C
export WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true

echo "--- L1, L2: rate limits on two instances, tight limits, restart in between ---"
export RATE_LIMIT_READ=20/1m RATE_LIMIT_WRITE=5/1m RATE_LIMIT_CREATE=3/1m,5/1d RATE_LIMIT_CHECK=3/10s,7/1d RATE_LIMIT_WEBHOOK=2/1m
if app_up; then
  if serve 3101 "$S/app2.log" 200; then
    APP2=$SERVED_PID
    phase L1
    app_down
    if app_up; then phase L2; app_down; else fail "app did not restart for L2"; fi
    unserve "$APP2" 3101 || fail "app on 3101 did not stop"
  else
    fail "second instance did not start for L1"; app_down
  fi
else
  fail "app did not start for L1"
fi
export RATE_LIMIT_READ=$GENEROUS RATE_LIMIT_WRITE=$GENEROUS RATE_LIMIT_CREATE=$GENEROUS RATE_LIMIT_CHECK=$GENEROUS RATE_LIMIT_WEBHOOK=$GENEROUS

echo "--- P: webhook delivery retention ---"
with_app P
echo "--- Y: Retry-After ---"
with_app Y
echo "--- H: worker health ---"
with_app H

echo "--- S: invite-only accounts, authorization, auth rate limits ---"
with_app S

echo "--- S2: production session cookie on an https base URL (separate instance) ---"
EMAIL=$(node -e 'console.log(require(process.argv[1]).email)' "$S/secrets.json")
PASS=$(node -e 'console.log(require(process.argv[1]).password)' "$S/secrets.json")
if BETTER_AUTH_URL=https://localhost:3103 serve 3103 "$S/app3.log" 200; then
  APP4=$SERVED_PID
  SC=$(curl -s -o /dev/null -D - -X POST http://localhost:3103/api/auth/sign-in/email -H 'content-type: application/json' -H 'origin: https://localhost:3103' -H 'x-forwarded-for: 192.0.2.10' --data "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | tr -d '\r' | grep -i '^set-cookie:.*session_token=')
  if printf '%s' "$SC" | grep -q '__Secure-better-auth.session_token=' && printf '%s' "$SC" | grep -qi '; Secure' && printf '%s' "$SC" | grep -qi 'HttpOnly' && printf '%s' "$SC" | grep -qi 'SameSite=Lax'; then
    echo "PASS [S2] https base URL: session cookie is __Secure-, Secure, HttpOnly, SameSite=Lax"
  else echo "FAIL [S2] https cookie flags: $(printf '%s' "$SC" | sed 's/=[^;]*/=…/')"; rc=1; fi
  unserve "$APP4" 3103 || fail "app on 3103 did not stop"
else
  fail "S2 instance did not start"
fi

echo "--- S3: production without BETTER_AUTH_SECRET refuses to authenticate (separate instance + worker) ---"
SAVED_SECRET="$BETTER_AUTH_SECRET"; unset BETTER_AUTH_SECRET
if serve 3104 "$S/app3.log" any; then
  APP5=$SERVED_PID
  GS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3104/api/auth/get-session)
  SI=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3104/api/auth/sign-in/email -H 'content-type: application/json' -H 'origin: http://localhost:3100' --data "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
  if [ "$GS" -ge 500 ] && [ "$SI" -ge 500 ] && grep -q "BETTER_AUTH_SECRET must be set in production" "$S/app3.log"; then
    echo "PASS [S3] no BETTER_AUTH_SECRET in production: auth refuses (get-session $GS, sign-in $SI), no fallback secret"
  else echo "FAIL [S3] missing secret: get-session=$GS sign-in=$SI"; rc=1; fi
  unserve "$APP5" 3104 || fail "app on 3104 did not stop"
else
  fail "S3 instance did not start"
fi
if WOUT=$(NODE_OPTIONS= npm run -s worker:once 2>&1); then
  echo "FAIL [S3] worker started without BETTER_AUTH_SECRET in production"; rc=1
elif printf '%s' "$WOUT" | grep -q "BETTER_AUTH_SECRET must be set in production"; then
  echo "PASS [S3] the worker refuses to start without BETTER_AUTH_SECRET in production"
else echo "FAIL [S3] worker failed for another reason: $(printf '%s' "$WOUT" | tail -3)"; rc=1; fi
export BETTER_AUTH_SECRET="$SAVED_SECRET"

echo "--- H2: worker health when the database is unreachable (separate instance) ---"
if DATABASE_URL="$PG_BASE/does_not_exist_e2e" serve 3102 "$S/app3.log" any; then
  APP3=$SERVED_PID
  W=$(curl -s -w ' %{http_code}' http://localhost:3102/api/health/worker); H=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3102/api/health)
  if [ "$W" = '{"status":"unknown"} 503' ] && [ "$H" = "503" ]; then echo "PASS [H2] database unreachable: worker health → 503 {\"status\":\"unknown\"} with no details"; else echo "FAIL [H2] db unreachable: worker=$W web=$H"; rc=1; fi
  unserve "$APP3" 3102 || fail "app on 3102 did not stop"
else
  fail "H2 instance did not start"
fi

echo "--- K: the outbox uses the database clock (app clock 5s behind) ---"
NODE_OPTIONS= npx tsx e2e/clock-test.mts && echo "PASS [K] immediate send claims a just-queued delivery despite app clock skew" || { echo "FAIL [K] clock skew"; rc=1; }

kill $FAKES 2>/dev/null; wait $FAKES 2>/dev/null
exit $rc
