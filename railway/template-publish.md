# Railway template — publisher checklist

Use this when converting the repo into a published template in the [template composer](https://docs.railway.com/templates/create). It mirrors [Template best practices](https://docs.railway.com/templates/best-practices).

The production layout (PostgreSQL + `web` + `worker`) is defined in [`.railway/railway.ts`](../.railway/railway.ts); keep the template consistent with it.

## Icons (template + service)

- Upload **`railway/icon.svg`** (or export it as PNG) for the **template** and both services.
- Prefer **1:1** aspect ratio; this asset is square **24×24** viewBox (scale up as needed).

## Naming

- **Template name:** **webdog.ai** (matches product naming).
- **Service names:** **web** (dashboard + API) and **worker** (scheduled checks and webhook delivery).

## Private networking

- This stack is two app services (**web**, **worker**) plus a **PostgreSQL** service. Only **web** gets a public domain; keep database traffic internal/private.
- Do **not** point Better Auth or browser-facing URLs at **`RAILWAY_PRIVATE_DOMAIN`** — it is internal-only. See README **Deploy on Railway**.

## Database

- Add a Railway **PostgreSQL** service.
- Wire **`DATABASE_URL`** on both services to the PostgreSQL connection string.
- Both services run **`npm run db:migrate:deploy`** as their pre-deploy command (lock-protected, safe to run from both).

## Health checks

- **Healthcheck path (web only):** **`/api/health`**. The worker has no HTTP endpoint; restart policy **Always**.
- **Timeout:** **`300`** seconds (adjust if your builds are slower).
- Endpoint verifies PostgreSQL is reachable (readiness-style check).

## Authentication

- Required **`BETTER_AUTH_SECRET`**: prefer generating one with a template variable function instead of hardcoding — example value:

  `${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=`

## Environment variables (composer)

Set descriptions in the Railway UI exactly as below so deployers know what to enter.

| Name | Required | Description |
|------|----------|-------------|
| **`CONTEXT_DEV_API_KEY`** | Yes | Bearer API key from [context.dev](https://link.context.dev/webdog). Required for scraping and extraction. |
| **`RESEND_API_KEY`** | No | Server-managed Resend API key for email notifications. When set with **`RESEND_SEND_FROM_EMAIL`**, users configure recipients only. |
| **`RESEND_SEND_FROM_EMAIL`** | No | Server-managed sender address for email notifications. When set, the sender is not editable in the dashboard. |
| **`MAX_ALERTS`** | No | Maximum number of active monitors per account. Omit for unlimited monitors. |
| **`POSTFIX_TO_ALERTS`** | No | Optional text appended to new alert titles and outbound email subjects. |
| **`DATABASE_URL`** | Yes | PostgreSQL connection string. Wire this from the Railway PostgreSQL service. |
| **`BETTER_AUTH_SECRET`** | Yes | Secret for Better Auth cookie/session crypto. Set **`${{secret(...)}}`** as above. |
| **`BETTER_AUTH_URL`** | Worker: yes | Full public **`https://…`** origin. On **web**, omit it to use Railway’s public hostname (**`RAILWAY_PUBLIC_DOMAIN`**). On **worker**, set it to **`https://${{web.RAILWAY_PUBLIC_DOMAIN}}`**: the worker has no domain and fails to start without a public URL. |
| **`NEXT_PUBLIC_APP_URL`** | No | Same origin as **`https://…`** for the Next.js client bundle when **`RAILWAY_PUBLIC_DOMAIN`** is missing or must be overridden. |
| **`BETTER_AUTH_ALLOWED_HOSTS`** | No | Comma-separated host patterns (wildcards ok, e.g. **`*.up.railway.app`**) when users may hit multiple public hostnames. |
| **`BETTER_AUTH_TRUSTED_ORIGINS`** | No | Extra allowed origins for Better Auth (comma-separated full origins). |
| **`SCRAPE_CRON`** | No | Cron expression for the worker service (default **`*/15 * * * *`**). |
| **`NODE_ENV`** | Yes | **`production`** on both services. |

Reference **`DATABASE_URL`** from the PostgreSQL service into both app services. Set the auth and provider variables on both.

## Workspace naming

- Use your **own** workspace name unless you are officially affiliated with a brand you’re naming — see Railway’s workspace guidance in [best practices](https://docs.railway.com/templates/best-practices).

## Marketplace overview (paste into template overview)

```markdown
# Deploy and Host webdog.ai with Railway

webdog.ai is open-source website change monitoring: scrape pages, compare versions over time, and get alerts when content moves, disappears, or edits. Deploy it as a Next.js app backed by PostgreSQL.

## About Hosting webdog.ai

You deploy two Railway services from this repository (the web app and a background worker) and one PostgreSQL service for storage. Database migrations run before either service starts; the web app serves the UI over HTTPS and the worker runs scheduled scrapes and webhook delivery. You supply a context.dev API key for scraping; Better Auth defaults to Railway’s public domain when **`BETTER_AUTH_URL`** is left unset.

## Common Use Cases

- Monitor pricing, availability, or copy on storefronts and dashboards.
- Detect unauthorized or accidental content changes on marketing sites.
- Track competitor pages or documentation when you need diff history.
- Self-host alerts without handing URLs to a third-party SaaS.

## Dependencies for webdog.ai Hosting

- **Node.js** app (Next.js 15) built via **`npm run build`**
- **PostgreSQL** database service exposed to the app as **`DATABASE_URL`**
- **context.dev** API access (**`CONTEXT_DEV_API_KEY`**)
- **Better Auth** for accounts (**`BETTER_AUTH_SECRET`**)

### Deployment Dependencies

- Source repository URL you attach to the template service (your **`https://github.com/…/webdog-ai`** fork or canonical repo)
- Railway PostgreSQL service
- [context.dev](https://link.context.dev/webdog)
- [Railway health checks](https://docs.railway.com/guides/healthchecks)
- [Template best practices](https://docs.railway.com/templates/best-practices)

### Why Deploy webdog.ai on Railway?

Railway hosts your infrastructure so you avoid manual server setup while keeping data in managed PostgreSQL and scaling the service when needed. Run this app alongside databases, workers, and other services on one platform with minimal operational overhead.
```
