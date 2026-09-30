// Railway Infrastructure as Code for Webdog production (replaces the deprecated railway.json).
// Preview with `railway config plan`, apply with `railway config apply`. See README "Deployment".
//
// - postgres: the database, reached over Railway's private network.
// - web:      dashboard + /api/v1, public HTTPS domain, health-checked.
// - worker:   scheduled checks and webhook delivery/retries; no domain.
//
// Services have no GitHub `source` on purpose: nothing deploys on push. Releases are manual
// (`railway up --service <name>` from a clean checkout of the release commit).
//
// This file describes the whole project: `railway config apply` can delete resources and
// variables that are not declared here. Set tunables here, not in the dashboard. Secrets
// use preserve(): their values are entered in the Railway dashboard and applies never
// overwrite or print them.

import { defineRailway, postgres, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const db = postgres("postgres");

  // Both services apply pending migrations before starting; scripts/migrate.ts holds an
  // advisory lock, so they never race and neither starts new code on an old schema.
  const migrate = "npm run db:migrate:deploy";

  const shared = {
    DATABASE_URL: db.env.DATABASE_URL,
    NODE_ENV: "production",
    // Required secrets (set in the dashboard).
    BETTER_AUTH_SECRET: preserve(),
    CONTEXT_DEV_API_KEY: preserve(),
    // Optional provider settings (set in the dashboard when used).
    OPENAI_API_KEY: preserve(),
    AI_GATEWAY_API_KEY: preserve(),
    AI_MODEL: preserve(),
    RESEND_API_KEY: preserve(),
    RESEND_SEND_FROM_EMAIL: preserve(),
  };

  const web = service("web", {
    build: "npm run build",
    preDeploy: migrate,
    start: "npm run start",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: 1,
    // Restart policy: Railway's default ("On Failure", max 10 restarts). Not declared, because
    // Railway stores its default as unset and an explicit value shows as permanent plan drift.
    // The web app derives its public URL from RAILWAY_PUBLIC_DOMAIN. With a custom domain,
    // set BETTER_AUTH_URL to it here and on the worker.
    env: shared,
  });

  const worker = service("worker", {
    // The worker runs TypeScript with tsx and never uses the Next.js build output.
    build: "echo 'worker: no build step'",
    preDeploy: migrate,
    start: "npm run worker",
    replicas: 1,
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      ...shared,
      // The worker has no domain; auth (which throws on Railway without a public URL) and
      // the dashboard links in alerts and webhooks must use the web app's.
      BETTER_AUTH_URL: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
      SNAPSHOT_RETENTION_DAYS: "90",
    },
  });

  return project("webdog", { resources: [db, web, worker] });
});
