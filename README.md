<p align="center">
  <img src="./logo.png" width="120" alt="webdog.ai logo">
</p>

<h1 align="center">webdog.ai</h1>

<p align="center">
Watch any website. Know the moment it changes.
</p>

<p align="center">

⭐ Star us • 🏠 Self-hostable • 📜 MIT

</p>

<p align="center">
<img src="./hero.png" alt="webdog.ai dashboard">
</p>

---

## Built by the [Context.dev](https://link.context.dev/webdog) team 🥠

webdog.ai is a fully open-source website monitoring platform, built by the team at [Context.dev](https://link.context.dev/webdog) — the web context API for software and AI agents. Everything in this repository — scraping, structured extraction, screenshots, brand data — runs on the [Context.dev API](https://link.context.dev/webdog).

Paste any URL and webdog will:

- 📄 Scrape the page to clean markdown
- 🤖 Understand what changed with AI summaries
- 📸 Capture screenshots on every check
- 🔍 Generate visual, line-level diffs
- 🔔 Notify you instantly on Slack, email, or webhook

---

## Table of contents

- [Why?](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Notifications](#notifications)
- [Watcher API (v1)](#watcher-api-v1)
- [Security](#security)
- [Deployment](#deployment)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)
- [Built using Context.dev](#built-using-contextdev)
- [Contributing](#contributing)
- [License](#license)

---

## Why?

Perfect for monitoring:

- 🤖 AI announcements
- 💰 Pricing pages
- 💼 Job listings
- 📰 Blogs and changelogs
- 🛍️ Ecommerce product prices
- 📚 Documentation
- 🏛️ Government websites

---

## Features

### Three kinds of monitors

| Monitor | What it watches | Alerts on |
|---|---|---|
| **Site links** | The site's sitemap | New links, removed links, or both |
| **Page content** | A single page, scraped to markdown | Any content change, with a line-level diff |
| **Product price** | A product page | Price or currency changes (checks every 24h by default) |

Each monitor has its own check interval (fractional hours supported — `0.25` = every 15 minutes), an optional free-text *watch note* that labels the monitor and focuses the AI summary, and its own notification routing.

### Everything else

- **AI change summaries** — optional per-monitor plain-language summaries of what changed and why it matters, via OpenAI or the Vercel AI Gateway.
- **AI relevance filter** — optional per-monitor triage that scores each detected change against the monitor's watch note before it notifies. Routine noise (cookie banners, rotating ads, view counters, timestamps) is held in the dashboard instead of paging you. Nothing is deleted — held changes are still stored and viewable, just not delivered — and it fails open, so any triage error surfaces the alert normally.
- **Visual diffs** — GitHub-style added/removed line views for every content change.
- **Screenshots** — every check captures a fresh page screenshot, so you can see the current state at a glance.
- **Brand-aware dashboard** — adding a website auto-fills its logo, title, description, and a hero screenshot using [Context.dev](https://link.context.dev/webdog) brand data.
- **Alerts inbox** — every change is stored in-app with read/unread state, independent of external notifications.
- **Teams** — invite members with expiring, multi-use invite links; switch between accounts you belong to.
- **Public share links** — generate a read-only public page for any watched website (unguessable token, no login required).
- **Managed or self-serve keys** — run a managed deployment where the server provides API keys for all accounts, or let each account bring its own keys in Settings.

---

## How it works

```
┌─────────────┐     cron (SCRAPE_CRON)      ┌──────────────────┐
│   Worker    │ ───────────────────────────▶ │  Context.dev API │
│ (worker.ts) │   scrape / extract / shot    └──────────────────┘
└──────┬──────┘
       │ snapshots (sitemap / markdown / product)
       ▼
┌─────────────┐   hash compare vs previous   ┌──────────────────┐
│ PostgreSQL  │ ───────────────────────────▶ │      Alerts      │
└─────────────┘                              └────────┬─────────┘
                                                      │ + optional AI summary
                                                      ▼
                                     Slack · Email (Resend) · Webhook · Dashboard
```

1. A standalone worker (`scripts/worker.ts`) wakes up on a cron schedule (default every 15 minutes).
2. For each due monitor it scrapes via [Context.dev](https://link.context.dev/webdog) — sitemap, markdown, or product extraction — and stores a snapshot with a content hash.
3. The new snapshot is diffed against the previous one. Changes become alerts.
4. Alerts are stored in the dashboard and dispatched to the monitor's notification destinations, optionally with an AI-generated summary and the page screenshot.

The Next.js app serves the dashboard, auth, and API routes; the worker runs alongside it (a second process locally, a separate service on Railway).

---

## Quick start

**Prerequisites:** Node.js 22 (≥ 22.6), Docker (for local PostgreSQL), and a free [Context.dev API key](https://link.context.dev/webdog).

```bash
# 1. Clone
git clone https://github.com/context-dot-dev/webdog.git
cd webdog

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# (optional) add CONTEXT_DEV_API_KEY to .env — or paste a key per-account during onboarding

# 4. Database (PostgreSQL 16 via Docker)
npm run db:up
npm run db:push

# 5. Run — two terminals
npm run dev      # Next.js app on http://localhost:3000
npm run worker   # scrape/diff worker
```

Sign up at `http://localhost:3000`, add a website, and pick what to watch. Done.

> [!TIP]
> No `CONTEXT_DEV_API_KEY` in the environment? No problem — each account is asked for its own key during onboarding and can manage it later in **Settings**.

---

## Configuration

All configuration is environment variables (see `.env.example`). Everything except the database is optional — unset server keys simply shift configuration to per-account Settings in the dashboard.

### Core

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. Local Docker default: `postgres://postgres:postgres@localhost:5432/webdog_ai` |
| `POSTGRES_PORT` | No | Host port for the Docker Compose Postgres (default `5432`) |
| `CONTEXT_DEV_API_KEY` | No | Server-managed [Context.dev](https://link.context.dev/webdog) key used for all accounts. Leave blank to let each account save its own key in Settings |
| `SCRAPE_CRON` | No | Worker schedule, cron syntax (default `*/15 * * * *`) |
| `DATA_ENCRYPTION_KEY` | Prod only | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored credentials at rest (see [Security](#security)). **Back it up: if it is lost, stored credentials cannot be recovered.** Without it outside production, a development-only key is used, and only with a local (`localhost`) database |
| `DATA_ENCRYPTION_KEY_PREVIOUS` | No | Comma-separated old keys, still accepted for decryption during a key rotation |
| `SNAPSHOT_RETENTION_DAYS` | No | Delete stored snapshots older than this many days (the newest snapshot per monitored page is always kept as the diff baseline). Blank keeps all history |
| `WEBHOOK_POLL_SECONDS` | No | How often the worker sends due watch webhooks and retries (default `10`) |
| `WATCH_ERROR_THRESHOLD` | No | Failed checks in a row before a watch reports `watch.error` (default `3`) |
| `WEBHOOK_ALLOW_PRIVATE_ADDRESSES` | No | `true` lets webhooks reach private/internal addresses (localhost, 10.x, …). **Development and tests only**; leave unset in production |

### Auth (Better Auth)

| Variable | Required | Description |
|---|---|---|
| `BETTER_AUTH_SECRET` | Prod only | Session/cookie crypto secret. Generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | No | Public origin for auth callbacks. Local default `http://localhost:3000`; on Railway it is derived from `RAILWAY_PUBLIC_DOMAIN` automatically |
| `NEXT_PUBLIC_APP_URL` | No | Public origin for the client bundle when the platform domain env is missing or must be overridden |
| `BETTER_AUTH_ALLOWED_HOSTS` | No | Comma-separated host patterns (wildcards OK, e.g. `*.up.railway.app`) when serving multiple hostnames |
| `BETTER_AUTH_TRUSTED_ORIGINS` | No | Extra allowed origins, comma-separated |

### Notifications & AI (all optional)

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | Server-managed [Resend](https://resend.com) key for email alerts. When set with `RESEND_SEND_FROM_EMAIL`, users only configure recipients |
| `RESEND_SEND_FROM_EMAIL` | Server-managed sender address for email alerts |
| `OPENAI_API_KEY` | Server-managed OpenAI key for AI change summaries |
| `AI_GATEWAY_API_KEY` | Server-managed [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key (alternative to OpenAI) |
| `AI_MODEL` | Default summary model for all accounts (e.g. `gpt-5.4-nano` or `openai/gpt-5.4-nano`) |
| `POSTFIX_TO_ALERTS` | Attribution text appended to alert titles and notification footers |
| `MAX_ALERTS` | Max active monitors per account (blank = unlimited) |

---

## Notifications

Alerts always land in the in-app inbox. On top of that, each account can create any number of named **notification destinations** and route monitors to them:

- **Slack** — incoming webhook, rich Block Kit message with the diff, AI summary, and a link back to the dashboard.
- **Email** — sent through Resend; server-managed or per-account credentials.
- **Webhook** — JSON `POST` to any URL you control, with `User-Agent: webdog.ai/1.0`:

```jsonc
{
  "type": "webdog_ai.new_alerts",
  "version": 1,
  "kind": "new_alerts",
  "appBaseUrl": "https://your-instance.example.com",
  "site": { "id": "…", "name": "Stripe", "domain": "stripe.com" },
  "alerts": [
    {
      "id": "…",
      "targetId": "…",
      "title": "Pricing page content changed",
      "aiChangeSummary": "Pro plan dropped from $99 to $79/mo.",
      "diffPreview": "- Monthly: $99 / month\n+ Monthly: $79 / month",
      "dashboardUrl": "https://your-instance.example.com/dashboard/websites/…"
    }
  ],
  "summaryText": "…"
}
```

Every destination has a **send test** action in Settings so you can verify wiring before relying on it.

---

## Watcher API (v1)

A machine API under `/api/v1` lets another service (for example an AI agent platform) create and manage monitors, called **watches**, without the dashboard. Watches created through the API show up in the dashboard like any other monitor.

### Authentication

Create a key for an existing account (sign up in the dashboard first). The key acts as that account and is shown once; only its hash is stored:

```bash
npm run api-keys -- create --email you@example.com --name "My platform"
npm run api-keys -- list
npm run api-keys -- revoke <apiClientId>
npm run api-keys -- webhook-secret <apiClientId> [--rotate]
```

`create` also prints the client's **webhook signing secret** (`whsec_…`), used to verify the webhooks described below; `webhook-secret` shows it again or rotates it. Rotation takes effect immediately.

Send it on every request as `Authorization: Bearer wk_…`.

**Revoking a key** stops everything it created, without deleting anything:

- The key gets `401` on every request.
- Its watches no longer run: not on schedule, not through "Run now" in the dashboard, not through `POST /check`. No new events or webhooks are produced for them.
- Its `pending` webhook deliveries become `canceled` (terminal; `lastError` says the client was revoked) and are never sent. A request already on the network at that moment cannot be recalled: if it succeeds it is recorded as `delivered`, otherwise it stays `canceled`.
- Watches, events, snapshots and delivery history are kept. Other keys of the same account still see these watches with `status: "revoked"` and can read their events and deliveries or delete them; checking, updating, or retrying a delivery returns `409 watch_revoked`. The dashboard shows them likewise and refuses to run or edit them.
- Revoking is idempotent (the original revocation time is kept). There is no un-revoke: create a new key and new watches.

### Endpoints

| Method & path | What it does |
|---|---|
| `POST /api/v1/watches` | Create a watch (runs the first check before responding) |
| `GET /api/v1/watches` | List watches, newest first. Filters: `externalUserId`, `externalRef`, `type`, `enabled`; paging: `limit` (≤100), `cursor` |
| `GET /api/v1/watches/:id` | Get one watch |
| `PATCH /api/v1/watches/:id` | Update `intent`, `intervalMinutes`, `enabled`, `callbackUrl`, `externalUserId`, `externalRef`, `metadata`, `condition`, `triggerMode`, `aiTriageEnabled`, `aiSummaryEnabled` (send `null` to clear) |
| `DELETE /api/v1/watches/:id` | Delete a watch (`204`) |
| `GET /api/v1/watches/:id/deliveries` | Webhook delivery history: status (`pending` / `delivered` / `failed` / `canceled`), attempts, last status code and error. Filter `status`; paging `limit`, `cursor` |
| `POST /api/v1/deliveries/:id/retry` | Re-send a `failed` delivery with a fresh set of attempts |
| `POST /api/v1/webhooks/test` | Send one signed `webhook.test` event to `{"url": "…"}` to check your receiver |
| `POST /api/v1/watches/:id/check` | Check now, ignoring the schedule (`409` if a check of that website is already running) |
| `GET /api/v1/watches/:id/events` | Detected changes, newest first, including ones the AI filter held back (`suppressed: true`). Paging: `limit`, `cursor`; `includeSuppressed=false` to hide them |

```bash
curl -X POST https://your-instance.example.com/api/v1/watches \
  -H "Authorization: Bearer $WEBDOG_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/careers",
    "type": "page",
    "intent": "Tell me when an investment internship appears",
    "intervalMinutes": 60,
    "callbackUrl": "https://platform.example.com/hooks/webdog",
    "externalUserId": "user_123",
    "externalRef": "watch_456",
    "metadata": { "conversationId": "c_789" },
    "condition": { "type": "intent" },
    "triggerMode": "once"
  }'
```

- `callbackUrl` is stored encrypted and only ever returned masked (e.g. `https://platform.example.com/hooks/••••ab12`); send the full URL to change it.
- `type` is `page` (content changes, the default), `price` (product price), or `links` (the site's sitemap; the URL's domain is used).
- `intent` (≤300 characters) labels the watch and steers the AI relevance filter and summaries.
- `intervalMinutes` is 15–525600 (default 1440).
- `externalRef` makes creation idempotent: re-sending the same value returns the existing watch (`200`, `"replayed": true`).
- The first check runs before the response (`"baseline": {"status": "completed"}`). An unreachable page returns `422 baseline_failed`, and a `price` watch on a page with no product returns `422 not_a_product_page`; nothing is kept in either case. Pass `"baseline": false` to skip this and let the worker take the first snapshot.
- Several watches may target the same URL (for example, different users with different intents). Each keeps its own baseline, so each sees every change since its own last check.

#### Conditions

Without a `condition`, every detected change notifies. With one, only changes that satisfy it notify; the rest are still recorded as events with `suppressed: true` and the reason.

| `condition` | Notifies when | Needs |
|---|---|---|
| `{"type": "intent"}` | The AI judges that *this change* satisfies the watch's `intent`, e.g. "an investment internship appears" or "availability opens". It sees the added and removed lines with the page as context, and quotes verbatim evidence. | Non-empty `intent`; an AI provider for the account (`OPENAI_API_KEY` / `AI_GATEWAY_API_KEY` or per-account keys) |
| `{"type": "price_below", "value": 200, "currency": "USD"}` | The price *crosses* below `value` (for example 219 → 189); a price that stays below does not re-notify. `currency` is optional; when set, prices in another currency never match. No AI involved. | A `price` watch |
| `{"type": "price_above", "value": 100}` | The price crosses above `value`. | A `price` watch |

- Unclear AI answers count as no match. If the AI cannot be reached or answers unreadably, the change is **delivered anyway** with `condition.status: "error"`, so an outage never hides a real match.
- A watch with a condition skips the general AI relevance filter.
- `"triggerMode": "once"` stops the watch after its first matched notification (`status: "triggered"`); `PATCH {"enabled": true}` re-arms it. An `error` outcome does not use up the trigger.
- When a watch with a condition is created, `baseline.condition` says whether the page **already** satisfies it (for example `"Already below USD 200: currently USD 180."`), so you can tell the user right away.
- Events and webhook alerts carry `condition: {"status": "matched" | "not_matched" | "error", "reason", "evidence": [...]}`.

#### Webhooks

A watch with a `callbackUrl` receives signed JSON `POST`s:

| Event | Sent when | Body (besides `id`, `type`, `createdAt`, `watch`) |
|---|---|---|
| `watch.triggered` | A change is delivered for the watch (its condition matched, or it has none) | `event` (the same object `GET /events` returns, incl. `condition` and evidence), `dashboardUrl` |
| `watch.error` | Checks have failed `WATCH_ERROR_THRESHOLD` (3) times in a row; once per failure streak | `error: {message, consecutiveFailures, failingSince}` |
| `watch.recovered` | A watch that reported `watch.error` checks successfully again | `recovery: {failedChecks, failingSince}` |

`watch` is the watch as the API returns it (minus `callbackUrl`, which is the receiver itself), including your `externalUserId`, `externalRef`, and `metadata`, so you can route the event without a lookup. Held changes (condition not met) are not sent.

Headers: `X-Watcher-Event-Id` (equals the body `id`), `X-Watcher-Event-Type`, `X-Watcher-Attempt`, and `X-Watcher-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of `"<t>.<raw body>"` keyed with your webhook secret. Verify it against the raw body and reject stale timestamps:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(header: string, rawBody: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(expected, given);
}
```

**Allowed targets.** Webhooks (watch callbacks, the test endpoint, and dashboard WEBHOOK destinations) may only reach publicly routable addresses. URLs whose host is, or resolves to, a private, loopback, link-local (including cloud metadata `169.254.169.254`), carrier-grade NAT, unique-local IPv6, multicast, or other reserved address are refused when saved (`422 callback_url_not_allowed`, or `400` in the dashboard). The same rule is enforced again while connecting, so a hostname that later resolves to an internal address (DNS rebinding) is blocked before anything is sent; such deliveries fail immediately and are not retried. For local development with a receiver on localhost, set `WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true`.

Delivery is **at-least-once**: events are written to an outbox in the same transaction as the change and sent immediately. Any non-2xx response, timeout (10s), or network error is retried after 30s, 2m, 10m, 30m, 1h, 3h, 6h, and 12h (±10% jitter). After 9 attempts the delivery is `failed` (retry it with `POST /deliveries/:id/retry`); `410 Gone` fails it at once. Redirects are not followed. The same event keeps the same `X-Watcher-Event-Id` and body on every attempt, so dedupe on it and return 2xx quickly.

> Watches created before signed webhooks were routed through an unsigned `webdog_ai.new_alerts` WEBHOOK destination. The migration moves their `callbackUrl` onto the watch, so they now receive the signed events above instead. Dashboard WEBHOOK destinations are unchanged and still receive the `webdog_ai.new_alerts` payload.

Errors always look like `{"error": {"code": "…", "message": "…"}}` (`401 unauthorized`, `404 not_found`, `409 check_in_progress` / `external_ref_conflict` / `watch_revoked` / `delivery_not_failed`, `422 validation_failed` / `invalid_url` / `invalid_cursor` / `intent_required` / `ai_not_configured` / `condition_not_supported` / `callback_url_not_allowed`, `403 monitor_limit_reached`).

---

## Security

**Credentials are encrypted at rest.** API-key webhook signing secrets, per-account Context.dev / OpenAI / AI Gateway / Resend keys, Slack and webhook destination URLs, watch callback URLs, and queued webhook URLs are stored with AES-256-GCM (random nonce per value, the column bound as authenticated data) under `DATA_ENCRYPTION_KEY`. The key lives only in the environment, never in the database or the repo. Stored values look like `enc:v1:<keyId>:…`.

- **Never sent back decrypted.** The dashboard and the API show masked values (`••••ab12`, `https://hooks.slack.com/services/••••ab12`). Saving a form with a masked value unchanged keeps the stored credential; type a new value to replace it. Errors and logs never include credential values.
- **Existing plaintext is encrypted automatically** by `npm run db:migrate:deploy` (under the migration lock). The backfill checks each ciphertext before writing it and only replaces the exact value it read, so it is safe to interrupt and re-run. It also removes the plaintext `watch.callbackUrl` copy from webhook payloads queued before encryption. `npm run secrets -- verify` reports anything still plaintext or undecryptable.
- **Key rotation:** set the new key as `DATA_ENCRYPTION_KEY` and the old one in `DATA_ENCRYPTION_KEY_PREVIOUS`; values encrypted with either key decrypt, new writes use the new key. (Re-encrypting existing values under the new key is not automated yet; keep the old key configured until then.)
- **Losing the key loses the stored credentials** (users re-enter their keys and destinations; rotate API clients' webhook secrets). Back it up somewhere other than the database.
- Before encryption, credentials were stored in plaintext. Old row versions can linger in Postgres dead tuples, WAL, and backups after the backfill; rotate any credential whose earlier exposure matters.

**Security backlog** (known, not yet done):

- **Hash `website.publicShareToken`.** Public share links are bearer tokens stored in plaintext. Store a hash instead (a deterministic hash keeps the exact-match lookup working); the dashboard would then show a link only when it is created.
- **Review Better Auth's storage of `session.token` and `verification.value`.** Both are plaintext in the database by the library's design; confirm what a database read alone allows (session cookies are signed with `BETTER_AUTH_SECRET`) and whether hashing them is supported.
- **Remove transitional plaintext reads.** `decryptSecret` still returns values without the `enc:` prefix as-is, so legacy rows keep working during the backfill. Drop this once every database reports zero plaintext in `npm run secrets -- verify`.
- **Automate key rotation.** Add a command that re-encrypts every value under the current `DATA_ENCRYPTION_KEY`, so old keys can be removed from `DATA_ENCRYPTION_KEY_PREVIOUS`.

---

## Deployment

### Railway

Production runs on Railway as three resources, defined in code in [`.railway/railway.ts`](./.railway/railway.ts) (Railway Infrastructure as Code):

| Resource | Runs | Notes |
|---|---|---|
| `postgres` | Railway PostgreSQL | Private networking only |
| `web` | `npm run build` → pre-deploy `npm run db:migrate:deploy` → `npm run start` | Public HTTPS domain; health check `/api/health` (verifies Postgres); restarts on failure (Railway's default: up to 10 times) |
| `worker` | no build step → pre-deploy `npm run db:migrate:deploy` → `npm run worker` | No domain; always restarted; runs scheduled checks and webhook delivery/retries. Keep exactly **one** replica |

Both services run `npm run db:migrate:deploy` ([`scripts/migrate.ts`](./scripts/migrate.ts)) before starting. It applies pending migrations while holding a Postgres advisory lock, so the two services never migrate at the same time and neither starts new code against an old schema. Pending migrations apply in one transaction: if one fails, the database is left unchanged and the deploy stops before the new code starts.

**Deploys are manual.** The services have no GitHub source, so pushing or merging never deploys. To release a commit:

```bash
railway link                                   # once: select the Webdog project
git worktree add ../webdog-release <commit>    # a clean checkout of exactly what you ship
cd ../webdog-release
railway up --service web --ci -m "release <commit>"
railway up --service worker --ci -m "release <commit>"
cd - && git worktree remove ../webdog-release
```

Before a release that includes migrations, take a backup (`railway connect postgres`, then `pg_dump`). To roll back code, redeploy the previous deployment in the Railway dashboard. Old code tolerates columns added by later migrations, but data migrations (such as `0006`, which moves API watch callbacks) are not undone by a code rollback.

**First-time setup**

1. Create an empty Railway project and `railway link` it.
2. `railway config plan` to review what `.railway/railway.ts` will create, then `railway config apply`.
3. In the Railway dashboard, set the secret variables on **both** `web` and `worker`, with the same values (they are declared with `preserve()`, so applies never overwrite or print them): `BETTER_AUTH_SECRET` and `DATA_ENCRYPTION_KEY` (generate each locally with `openssl rand -base64 32`; keep a backup of the encryption key) and `CONTEXT_DEV_API_KEY`; optionally `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY`, `AI_MODEL`, `RESEND_API_KEY`, `RESEND_SEND_FROM_EMAIL`.
4. Generate a public domain for `web` (`railway domain --service web`). The worker's `BETTER_AUTH_URL` references it; the worker cannot start without a public URL.
5. Release as above. The first deploy applies every migration to the empty database.

Notes:

- `.railway/railway.ts` describes the whole project: `railway config apply` can remove resources and variables it does not declare. Change settings such as `SNAPSHOT_RETENTION_DAYS` there, not in the dashboard, and don't run `apply` while temporary services you created by hand still exist.
- For a custom domain, add it to `web` in Railway, then set `BETTER_AUTH_URL=https://your-domain` for **both** services in `.railway/railway.ts`.
- Monitoring: Railway logs per service (`railway logs --service worker`). The worker logs every scrape run and every webhook batch. The `web` health check covers the web app only; automated worker-health monitoring (e.g. a heartbeat exposed through `/api/health`) is a planned hardening item.
- `.railway/railway.ts` is type-checked (`npm run typecheck`) and covered by `src/lib/railway-config.test.ts`; `railway config plan` needs a linked project.

Publishing it as a Railway template? See [`railway/template-publish.md`](./railway/template-publish.md).

### Anywhere else

webdog is a plain Next.js app plus a Node worker. Any host that runs Node 22 and reaches a PostgreSQL database works:

```bash
npm ci
npm run build
npm run db:migrate:deploy   # safe to run from several processes at once
npm run worker &            # long-running process
npm run start               # next start
```

Set `BETTER_AUTH_URL` (or `NEXT_PUBLIC_APP_URL`) to your public origin and `BETTER_AUTH_SECRET` to a random value, for both the web process and the worker.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run worker` | Run the scrape/diff worker on the cron schedule |
| `npm run worker:once` | Single worker pass, then exit (handy for debugging) |
| `npm run api-keys -- <create\|list\|revoke\|webhook-secret>` | Manage Watcher API keys and webhook secrets |
| `npm run secrets -- <encrypt [--dry-run]\|verify>` | Encrypt remaining plaintext credentials / check that every stored credential decrypts |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run db:up` / `npm run db:down` | Start / stop local Postgres via Docker Compose |
| `npm run db:push` | Push the Drizzle schema to the database (local dev) |
| `npm run db:migrate` | Apply SQL migrations from `drizzle/` |
| `npm run db:migrate:deploy` | Apply migrations under an advisory lock (production pre-deploy; safe to run concurrently) |
| `npm run db:generate` | Generate a new migration from schema changes |
| `npm run db:check` | Verify the database is reachable |
| `npm run db:reset` | Drop and recreate the schema (destructive) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript checks |

---

## Project structure

```
src/
  app/                  # Next.js App Router
    api/                # REST routes (websites, targets, alerts, account, auth, cron, health)
      v1/               # Watcher API for other services (API-key auth)
    dashboard/          # Authenticated app (sites, monitors, alerts, settings)
    onboarding/         # Context.dev key onboarding
    share/[token]/      # Public read-only share pages
    invite/[token]/     # Team invite redemption
    page.tsx            # Landing page
  components/           # React components
  lib/                  # Domain logic
    context-client.ts   # Typed wrapper around the Context.dev SDK
    scraper.ts          # Scrape + diff pipeline (used by worker & manual runs)
    db/schema.ts        # Drizzle schema (source of truth for the data model)
    notify-*.ts         # Slack / Resend / webhook delivery
    ai-change-summary.ts# LLM summaries of diffs
    ai-alert-triage.ts  # LLM relevance filter that holds noisy changes
scripts/
  worker.ts             # Cron worker entrypoint
  migrate.ts            # Lock-protected production migrations
  api-keys.ts           # Create / list / revoke Watcher API keys
drizzle/                # SQL migrations
.railway/railway.ts     # Railway Infrastructure as Code (postgres, web, worker)
railway/                # Railway template assets & publish checklist
```

`CONTEXT.md` names the core domain concepts (Account, Website, Monitor, Alert, Notification Destination…) if you want the vocabulary before diving in.

---

## Tech stack

- ▲ **Next.js 15** (App Router) + React 19 + TypeScript
- ⚡ **[Context.dev](https://link.context.dev/webdog)** — scraping, extraction, screenshots, brand data
- 🐘 **PostgreSQL 16** + Drizzle ORM
- 🔑 **Better Auth** — email/password auth, sessions
- 🎨 **Tailwind CSS**
- 🤖 **Vercel AI SDK** — OpenAI / AI Gateway for change summaries
- ⏰ **node-cron** — worker scheduling
- 🐳 **Docker Compose** — local Postgres

---

## Built using [Context.dev](https://link.context.dev/webdog)

Want to build your own AI-powered scraper or agent? The same API that powers webdog gives you markdown scraping, full-site crawls, structured extraction, screenshots, and brand data in one SDK:

```ts
import ContextDev from "context.dev";

const client = new ContextDev({ apiKey: process.env.CONTEXT_DEV_API_KEY });

const { markdown } = await client.web.webScrapeMd({ url: "https://openai.com" });
```

👉 **[Get your free API key →](https://link.context.dev/webdog)**

---

## Contributing

PRs welcome ❤️

1. Fork and clone the repo, then follow the [Quick start](#quick-start).
2. Make your change. Keep `npm run lint` and `npm run typecheck` clean.
3. If you change the schema in `src/lib/db/schema.ts`, run `npm run db:generate` and commit the migration.
4. Open a PR with a short description of the why.

If you build something cool using [Context.dev](https://link.context.dev/webdog), we'd love to feature it.

---

## License

[MIT](./LICENSE) © [Context.dev](https://link.context.dev/webdog)
