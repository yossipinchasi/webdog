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

The Next.js app serves the dashboard, auth, and API routes; the worker runs alongside it (a second process locally, one container on Railway).

---

## Quick start

**Prerequisites:** Node.js ≥ 20.9, Docker (for local PostgreSQL), and a free [Context.dev API key](https://link.context.dev/webdog).

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
| `SNAPSHOT_RETENTION_DAYS` | No | Delete stored snapshots older than this many days (the newest snapshot per monitored page is always kept as the diff baseline). Blank keeps all history |

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
```

Send it on every request as `Authorization: Bearer wk_…`.

### Endpoints

| Method & path | What it does |
|---|---|
| `POST /api/v1/watches` | Create a watch (runs the first check before responding) |
| `GET /api/v1/watches` | List watches, newest first. Filters: `externalUserId`, `externalRef`, `type`, `enabled`; paging: `limit` (≤100), `cursor` |
| `GET /api/v1/watches/:id` | Get one watch |
| `PATCH /api/v1/watches/:id` | Update `intent`, `intervalMinutes`, `enabled`, `callbackUrl`, `externalUserId`, `externalRef`, `metadata`, `condition`, `triggerMode`, `aiTriageEnabled`, `aiSummaryEnabled` (send `null` to clear) |
| `DELETE /api/v1/watches/:id` | Delete a watch (`204`) |
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

Changes are delivered to `callbackUrl` as the [webhook payload](#notifications) above; `alerts[].targetId` is the watch `id`. Errors always look like `{"error": {"code": "…", "message": "…"}}` (`401 unauthorized`, `404 not_found`, `409 check_in_progress` / `external_ref_conflict`, `422 validation_failed` / `invalid_url` / `invalid_cursor` / `intent_required` / `ai_not_configured` / `condition_not_supported`, `403 monitor_limit_reached`).

---

## Deployment

### Railway (one-click-ish)

The repo ships with a [`railway.json`](./railway.json) that builds the app, runs migrations, and starts the worker and web server in one service:

```
npm run db:migrate → npm run worker (background) → next start
```

1. Create a Railway project with a **PostgreSQL** service and a service from this repo.
2. Wire `DATABASE_URL` from the Postgres service, set `CONTEXT_DEV_API_KEY` and `BETTER_AUTH_SECRET`.
3. Enable public networking — auth URLs derive from `RAILWAY_PUBLIC_DOMAIN` automatically.
4. Health check is served at `/api/health` (readiness-style, verifies Postgres).

Publishing it as a Railway template? Follow the checklist in [`railway/template-publish.md`](./railway/template-publish.md).

### Anywhere else

webdog is a plain Next.js app plus a Node worker — any host that runs Node 20+ and reaches a PostgreSQL database works:

```bash
npm ci
npm run build
npm run db:migrate
npm run worker &      # long-running process
npm run start         # next start
```

Set `BETTER_AUTH_URL` (or `NEXT_PUBLIC_APP_URL`) to your public origin and `BETTER_AUTH_SECRET` to a random value.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run worker` | Run the scrape/diff worker on the cron schedule |
| `npm run worker:once` | Single worker pass, then exit (handy for debugging) |
| `npm run api-keys -- <create\|list\|revoke>` | Manage Watcher API keys |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run db:up` / `npm run db:down` | Start / stop local Postgres via Docker Compose |
| `npm run db:push` | Push the Drizzle schema to the database (local dev) |
| `npm run db:migrate` | Apply SQL migrations from `drizzle/` (production) |
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
  api-keys.ts           # Create / list / revoke Watcher API keys
drizzle/                # SQL migrations
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
