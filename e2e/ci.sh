#!/bin/bash
# The full integration suite, as CI runs it (also runnable locally; see e2e/README.md).
# Needs a Postgres reachable at $E2E_PG_BASE, a way to run psql/pg_dump inside its
# container ($E2E_PG_EXEC), and a production build (`npm run build`). Exits non-zero if
# any step fails. Every credential it uses is generated here, random, and test-only.
set -u
cd "$(dirname "$0")/.."

export E2E_PG_BASE="${E2E_PG_BASE:-postgres://postgres:postgres@localhost:5432}"
export E2E_PG_EXEC="${E2E_PG_EXEC:-docker compose exec -T postgres}"
export E2E_DIR="${E2E_DIR:-$(mktemp -d)}"
S="$E2E_DIR"
mkdir -p "$S"
# Fresh random key per run: test-only, never a real deployment's key.
openssl rand -base64 32 > "$S/key"
KEY="$(cat "$S/key")"

failures=()
step() { # step <name> <command…>
  local name="$1"; shift
  echo; echo "=== $name"
  if "$@"; then echo "--- ok: $name"; else echo "--- FAILED: $name"; failures+=("$name"); fi
}
pg() { $E2E_PG_EXEC psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
fresh_db() { pg -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"; }
with_db() { # with_db <db> <command…>: run with DATABASE_URL and the test key set
  local db="$1"; shift
  DATABASE_URL="$E2E_PG_BASE/$db" DATA_ENCRYPTION_KEY="$KEY" "$@"
}
same_files() { cmp -s "$1" "$2"; }

# 1. Legacy API webhook cleanup on a database that lived through the pre-signed-webhooks API.
fresh_db webdog_lg
step "legacy webhook cleanup (schema 0005 → current)" with_db webdog_lg npx tsx e2e/legacy-cleanup-test.mts
pg -c "DROP DATABASE IF EXISTS webdog_lg"

# 2. Delivery completion-time backfill (schema 0009 → current).
fresh_db webdog_bf
step "webhook delivery backfill (schema 0009 → current)" with_db webdog_bf npx tsx e2e/backfill-test.mts
pg -c "DROP DATABASE IF EXISTS webdog_bf"

# 3. Pre-encryption database with plaintext credentials → migrate, re-run, compare.
fresh_db webdog_e2e
step "seed a pre-encryption database (schema 0006)" with_db webdog_e2e npx tsx e2e/seed-legacy.mts
step "migrate (first run: encrypts the legacy credentials)" with_db webdog_e2e npm run -s db:migrate:deploy
step "every credential encrypted and decrypting to its original" with_db webdog_e2e npx tsx e2e/check-db.mts snap1.json
step "migrate again (must be a no-op)" with_db webdog_e2e npm run -s db:migrate:deploy
step "ciphertexts unchanged by the re-run" bash -c "DATABASE_URL='$E2E_PG_BASE/webdog_e2e' DATA_ENCRYPTION_KEY='$KEY' npx tsx e2e/check-db.mts snap2.json && cmp -s '$S/snap1.json' '$S/snap2.json'"

# 4. End-to-end phases against `next start`, the worker, and local fakes.
step "end-to-end suite (e2e/run.sh)" with_db webdog_e2e bash e2e/run.sh

# 5. No plaintext credential anywhere in the database or the logs.
step "secret scan of the database dump and logs" with_db webdog_e2e npx tsx e2e/scan.mts

# 6. Migrations after all that data: still a no-op; every stored credential decrypts.
step "snapshot after the E2E run" with_db webdog_e2e npx tsx e2e/check-db.mts snap3.json
step "migrate again after the E2E run (no-op)" with_db webdog_e2e npm run -s db:migrate:deploy
step "ciphertexts unchanged after the E2E run" bash -c "DATABASE_URL='$E2E_PG_BASE/webdog_e2e' DATA_ENCRYPTION_KEY='$KEY' npx tsx e2e/check-db.mts snap4.json && cmp -s '$S/snap3.json' '$S/snap4.json'"
step "secrets verify (0 plaintext, 0 undecryptable)" with_db webdog_e2e npm run -s secrets -- verify

echo
if [ ${#failures[@]} -eq 0 ]; then
  echo "ALL INTEGRATION STEPS PASSED"
  exit 0
fi
echo "FAILED STEPS:"; printf '  - %s\n' "${failures[@]}"
exit 1
