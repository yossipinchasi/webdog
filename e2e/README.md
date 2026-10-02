# Integration and end-to-end tests

These run in CI on every pull request (`.github/workflows/ci.yml`, job **integration**) and can be
run locally. They exercise the real app (`next start`, production build), the real worker, and
real Postgres, with local fakes for every outside service:

- `fakes.mjs`: Context.dev, OpenAI, Resend, Slack, and webhook receivers on `127.0.0.1:4010`
  (with per-URL delays, failure statuses, and response headers for race and retry tests)
- `intercept.mjs`: preloaded into the app and worker; routes the fixed Slack, Resend, and OpenAI
  hosts to the fakes. Nothing leaves the machine.

All credentials are generated per run (random, prefixed `test-only-` where they stand in for
provider keys) and never resemble a real key. The encryption key is a fresh random key per run.

## Run locally

```bash
npm run db:up            # local Postgres (docker compose)
npm run build
bash e2e/ci.sh           # everything below; exits non-zero on any failure
```

`e2e/ci.sh` uses `E2E_PG_BASE` (default `postgres://postgres:postgres@localhost:5432`) and
`E2E_PG_EXEC` (default `docker compose exec -T postgres`; CI uses `docker exec` into its Postgres 18
service container) to create and drop its own databases (`webdog_e2e`, `webdog_lg`, `webdog_bf`).
It never touches `webdog_ai`. Working files go to `E2E_DIR` (a temporary directory by default).

## What runs, in order

| Step | What it checks |
|---|---|
| `legacy-cleanup-test.mts` | A database at schema 0005 seeded the way the pre-signed-webhooks API wrote it, migrated for real; `npm run legacy-webhooks` removes only orphaned `API webhook (…)` destinations (dry run, apply, SIGKILL mid-run and resume, a row-lock race, re-runs) |
| `backfill-test.mts` | A database at schema 0009 with terminal deliveries; migration 0010 backfills `completedAt` exactly as specified |
| `seed-legacy.mts` → `db:migrate:deploy` ×2 → `check-db.mts` | A pre-encryption database with plaintext credentials: every credential is encrypted and decrypts to its original; re-running changes nothing byte for byte |
| `run.sh` | The end-to-end phases below, against `next start` and the worker |
| `scan.mts` | No test credential or token appears in plaintext in the full database dump or any app/worker log |
| `db:migrate:deploy` + `secrets verify` | After all that data: migrations still a no-op, every stored credential decrypts |

`run.sh` phases (each prints `PASS`/`FAIL` lines and a total):

| Phase | Covers |
|---|---|
| A | Phases 1–3 and 4.2: dashboard masking, share pages, Watcher API, conditions (price, AI intent), signed webhooks, retries, error/recovery events, encrypted credentials decrypted only where needed |
| B | Restart with the same encryption key: every credential still works |
| R | Revoked API keys: watches stop, pending deliveries canceled, history kept, races |
| C | SSRF protection with the production default |
| L1, L2 | Rate limits on two app instances sharing Postgres: 429s, `Retry-After`, concurrency, restart survival, cleanup |
| P | Webhook delivery retention: what is and isn't deleted, batching, interruption, concurrent pruners |
| Y | `Retry-After` on 429/503 webhook responses |
| H, H2 | Worker health heartbeats and `GET /api/health/worker` (also with the database unreachable) |
| K | The outbox schedules by the database clock even when the app clock is skewed |
| S, S2, S3 | Invite-only accounts (no sign-up without a valid invite; one account per invite use, also under concurrency; operator CLI), cross-account and member authorization, session cookie flags (also `Secure`/`__Secure-` on an https base URL), Better Auth's login rate limit, and refusal to run auth in production without `BETTER_AUTH_SECRET` |

## Repository secret scan

`e2e/repo-secret-scan.sh` (CI job **checks**) fails if any tracked file contains a
credential-shaped string (webhook secrets, encrypted values, provider/API keys, private keys,
cloud/GitHub/Slack tokens, 32-byte base64 keys). The lockfile and migration snapshots are skipped.
