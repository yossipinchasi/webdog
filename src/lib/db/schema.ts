import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../secret-box";

/**
 * A text column stored encrypted (AES-256-GCM, see `secret-box.ts`) and decrypted on
 * read, so every query handles ciphertext transparently. The purpose is bound into the
 * ciphertext. Never filter (WHERE/ORDER BY) on these columns: ciphertexts are randomized.
 */
function encryptedText(purpose: string) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => encryptSecret(value, purpose),
    fromDriver: (value) => decryptSecret(value, purpose),
  });
}

/* ------------------------------------------------------------------ */
/* BetterAuth core tables — field names follow the BetterAuth defaults. */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  /** Set when user finishes or defers Context.dev onboarding; null means gate /dashboard. */
  contextIntroDismissedAt: timestamp("contextIntroDismissedAt", { withTimezone: true, precision: 3 }),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }).notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }).notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true, precision: 3 }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true, precision: 3 }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }).notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }),
});

/**
 * One row per user: shared secrets (Resend API key, context.dev) not tied to a single destination.
 */
export const userNotificationSettings = pgTable("userNotificationSettings", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Per-account key used only when CONTEXT_DEV_API_KEY is not configured on the server. Encrypted. */
  contextDevApiKey: encryptedText("userNotificationSettings.contextDevApiKey")("contextDevApiKey"),
  /** Hotlinked brand icon URL from Context.dev (e.g. dashboard avatar). */
  accountBrandLogoUrl: text("accountBrandLogoUrl"),
  /** Per-account Resend API key used only when RESEND_API_KEY is not configured on the server. Encrypted. */
  resendApiKey: encryptedText("userNotificationSettings.resendApiKey")("resendApiKey"),
  /** openai | vercel_gateway — which LLM endpoint to use for change summaries. */
  aiProvider: text("aiProvider", { enum: ["openai", "vercel_gateway"] }),
  /** Per-account OpenAI key when OPENAI_API_KEY is not configured on the server. Encrypted. */
  openaiApiKey: encryptedText("userNotificationSettings.openaiApiKey")("openaiApiKey"),
  /** Per-account Vercel AI Gateway key when AI_GATEWAY_API_KEY is not configured on the server. Encrypted. */
  vercelAiGatewayApiKey: encryptedText("userNotificationSettings.vercelAiGatewayApiKey")("vercelAiGatewayApiKey"),
  /** Model id for change summaries (e.g. gpt-5.4-nano or openai/gpt-5.4-nano). */
  aiModel: text("aiModel"),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
});

/**
 * Named outbound integrations (Slack webhooks, email routes, generic JSON webhooks).
 */
export const notificationDestination = pgTable(
  "notificationDestination",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["SLACK", "EMAIL", "WEBHOOK"] }).notNull(),
    name: text("name").notNull(),
    /** Encrypted: Slack incoming-webhook URLs embed their token. */
    slackWebhookUrl: encryptedText("notificationDestination.slackWebhookUrl")("slackWebhookUrl"),
    resendFromEmail: text("resendFromEmail"),
    resendToEmails: text("resendToEmails"),
    /** Encrypted: webhook URLs often embed tokens. */
    alertWebhookUrl: encryptedText("notificationDestination.alertWebhookUrl")("alertWebhookUrl"),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byUser: index("notification_destination_user_idx").on(t.userId),
  }),
);

/**
 * Machine credentials for the `/api/v1` Watcher API. A client acts as its owner account.
 * Only a sha256 of the key is stored; the key itself is shown once, at creation.
 */
export const apiClient = pgTable(
  "apiClient",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("ownerUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Leading characters of the key (not secret) so operators can tell keys apart. */
    keyPrefix: text("keyPrefix").notNull(),
    /** sha256 hex of the full key. */
    keyHash: text("keyHash").notNull().unique(),
    /** HMAC-SHA256 key for signing this client's watch webhooks (`whsec_…`). Encrypted. */
    webhookSecret: encryptedText("apiClient.webhookSecret")("webhookSecret").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("lastUsedAt", { withTimezone: true, precision: 3 }),
    /** Set when the key is revoked; revoked keys never authenticate. */
    revokedAt: timestamp("revokedAt", { withTimezone: true, precision: 3 }),
  },
  (t) => ({
    byOwner: index("api_client_owner_idx").on(t.ownerUserId),
  }),
);

/* ------------------------------------------------------------------ */
/* Domain tables                                                      */
/* ------------------------------------------------------------------ */

export const website = pgTable(
  "website",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    description: text("description"),
    logoUrl: text("logoUrl"),
    /** context.dev /web/screenshot public URL; preferred over `backdropUrl` for hero/cards. */
    heroScreenshotUrl: text("heroScreenshotUrl"),
    backdropUrl: text("backdropUrl"),
    /**
     * JSON string array of notificationDestination ids to notify; null/empty = all destinations.
     * Use `[]` to disable notifications for this site.
     */
    notificationDestinationIds: text("notificationDestinationIds"),
    /** Unguessable token for a read-only public view; null = not shared. */
    publicShareToken: text("publicShareToken").unique(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byUser: index("website_user_idx").on(t.userId),
  }),
);

/**
 * Target types:
 *   SITEMAP_LINKS     — alert on sitemap URL changes (`linkScope` chooses new / removed / both).
 *   PAGE_CONTENT      — alert when a specific page's markdown changes
 *   PRODUCT_PRICE     — alert when a product page's price/currency changes (context.dev product API)
 */
export const target = pgTable(
  "target",
  {
    id: text("id").primaryKey(),
    websiteId: text("websiteId")
      .notNull()
      .references(() => website.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["SITEMAP_LINKS", "PAGE_CONTENT", "PRODUCT_PRICE"] }).notNull(),
    /** For SITEMAP_LINKS: which diffs notify. Null elsewhere. */
    linkScope: text("linkScope", { enum: ["NEW", "REMOVED", "BOTH"] }),
    /** For PAGE_CONTENT / PRODUCT_PRICE: the page URL. Null for sitemap-based targets. */
    pageUrl: text("pageUrl"),
    /** Optional free-text note of what the user wants to watch for; labels the monitor and focuses AI summaries. */
    watchNote: text("watchNote"),
    enabled: boolean("enabled").notNull().default(true),
    /** Minimum spacing between successful checks (hours, fractional OK — e.g. 0.25 = 15m); worker wakes per SCRAPE_CRON. */
    checkIntervalHours: doublePrecision("checkIntervalHours").notNull().default(1),
    /** Sole eligibility clock for scheduled runs; advanced by fixed interval after success. Null = due immediately. */
    nextCheckDueAt: timestamp("nextCheckDueAt", { withTimezone: true, precision: 3 }),
    lastCheckedAt: timestamp("lastCheckedAt", { withTimezone: true, precision: 3 }),
    /** Human-readable message from the most recent failed check; null once a check succeeds. */
    lastError: text("lastError"),
    /** When the last failed check happened; null once a check succeeds. */
    lastErrorAt: timestamp("lastErrorAt", { withTimezone: true, precision: 3 }),
    /** context.dev CDN screenshot URL of the watched page from the most recent check. */
    lastScreenshotUrl: text("lastScreenshotUrl"),
    /** When the stored screenshot was captured. */
    lastScreenshotAt: timestamp("lastScreenshotAt", { withTimezone: true, precision: 3 }),
    /**
     * When false, alerts are stored only in-app — no Slack/email/webhook for this target.
     * When true, `notificationDestinationId` selects the target's external destination.
     */
    externalNotify: boolean("externalNotify").notNull().default(true),
    notificationDestinationId: text("notificationDestinationId").references(
      () => notificationDestination.id,
      { onDelete: "set null" },
    ),
    /** When true, new alerts for this target get an LLM-generated plain-language summary. */
    aiChangeSummaryEnabled: boolean("aiChangeSummaryEnabled").notNull().default(false),
    /**
     * When true, a detected change is scored by the LLM against `watchNote` before it
     * notifies. Changes judged to be noise are stored as suppressed alerts (kept for the
     * audit trail, marked read, no Slack/email) instead of paging the owner. Fails open:
     * any triage error surfaces the alert normally.
     */
    aiTriageEnabled: boolean("aiTriageEnabled").notNull().default(false),
    /** API client that created this monitor through `/api/v1`; null for dashboard monitors. */
    apiClientId: text("apiClientId").references(() => apiClient.id, { onDelete: "set null" }),
    /** Caller's id for the end user this watch belongs to (opaque to Webdog). */
    externalUserId: text("externalUserId"),
    /** Caller's own id for this watch; unique per API client, so create retries are idempotent. */
    externalRef: text("externalRef"),
    /** Caller-supplied JSON object string, returned verbatim. */
    metadata: text("metadata"),
    /**
     * Optional JSON condition a detected change must satisfy before it notifies
     * (see `watch-conditions.ts`): `intent` (AI match against `watchNote`) or a
     * deterministic `price_below` / `price_above`. Null = every change notifies.
     */
    condition: text("condition"),
    /** `once`: disable the monitor after its first matched notification. */
    triggerMode: text("triggerMode", { enum: ["every", "once"] }).notNull().default("every"),
    /** When a `once` monitor fired and was disabled; cleared when it is re-enabled. */
    triggeredAt: timestamp("triggeredAt", { withTimezone: true, precision: 3 }),
    /** API watches: receives signed `watch.*` events through the webhook outbox. Encrypted. */
    callbackUrl: encryptedText("target.callbackUrl")("callbackUrl"),
    /** Failed checks in a row; reset by a successful check. Drives `watch.error` / `watch.recovered`. */
    consecutiveFailures: integer("consecutiveFailures").notNull().default(0),
    /** When the current run of failed checks started; null while healthy. */
    failingSince: timestamp("failingSince", { withTimezone: true, precision: 3 }),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byWebsite: index("target_website_idx").on(t.websiteId),
    byExternalUser: index("target_external_user_idx").on(t.externalUserId),
    byClientExternalRef: uniqueIndex("target_api_client_external_ref_idx")
      .on(t.apiClientId, t.externalRef)
      .where(sql`"externalRef" IS NOT NULL`),
  }),
);

/**
 * Snapshots store the raw scrape result at a point in time. The worker
 * compares each monitor's latest snapshot against a fresh scrape to generate alerts.
 *
 *  - kind=SITEMAP         payload = JSON string array of URLs
 *  - kind=MARKDOWN        payload = markdown body; targetUrl set
 *  - kind=PRODUCT        payload = JSON of extracted product/price; targetUrl = product page URL
 */
export const snapshot = pgTable(
  "snapshot",
  {
    id: text("id").primaryKey(),
    websiteId: text("websiteId")
      .notNull()
      .references(() => website.id, { onDelete: "cascade" }),
    /**
     * Monitor whose diff baseline this is. Each monitor diffs only against its own
     * snapshots, so several monitors on one URL never consume each other's changes.
     * Null for rows orphaned by a deleted monitor.
     */
    targetId: text("targetId").references(() => target.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["SITEMAP", "MARKDOWN", "PRODUCT"] }).notNull(),
    /** For MARKDOWN / PRODUCT: the URL. Null for SITEMAP. */
    targetUrl: text("targetUrl"),
    payload: text("payload").notNull(),
    /** sha256 of payload — cheap equality checks. */
    hash: text("hash").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byLookup: index("snapshot_lookup_idx").on(t.websiteId, t.kind, t.targetUrl, t.createdAt),
    byTarget: index("snapshot_target_idx").on(t.targetId, t.createdAt),
  }),
);

export const alert = pgTable(
  "alert",
  {
    id: text("id").primaryKey(),
    websiteId: text("websiteId")
      .notNull()
      .references(() => website.id, { onDelete: "cascade" }),
    targetId: text("targetId")
      .notNull()
      .references(() => target.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["NEW_LINK", "REMOVED_LINK", "PAGE_CONTENT", "PRODUCT_PRICE"] }).notNull(),
    title: text("title").notNull(),
    /** JSON: link/content/product fields depending on kind */
    details: text("details").notNull(),
    read: boolean("read").notNull().default(false),
    /**
     * True when the AI relevance filter judged this change to be noise. Suppressed alerts
     * are persisted (nothing is silently dropped) but arrive read and never notify.
     */
    suppressed: boolean("suppressed").notNull().default(false),
    /** Short LLM rationale for why the change was held; null unless suppressed. */
    suppressionReason: text("suppressionReason"),
    /**
     * Outcome of the monitor's condition for this change; null when it has none.
     * `not_matched` alerts are also suppressed. `error` = could not evaluate (delivered anyway).
     */
    conditionStatus: text("conditionStatus", { enum: ["matched", "not_matched", "error"] }),
    /** Short explanation of the condition outcome. */
    conditionReason: text("conditionReason"),
    /** JSON string array of verbatim snippets from the change that support a match. */
    conditionEvidence: text("conditionEvidence"),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byWebsite: index("alert_website_idx").on(t.websiteId, t.createdAt),
    byTarget: index("alert_target_idx").on(t.targetId),
  }),
);

/**
 * Outbox for signed watch webhooks. Rows are written in the same transaction as the
 * event that caused them, then delivered (and retried with backoff) by
 * `webhook-outbox.ts`. Delivery is at-least-once; `eventId` is stable across retries.
 */
export const webhookDelivery = pgTable(
  "webhookDelivery",
  {
    id: text("id").primaryKey(),
    /** Sent as `X-Watcher-Event-Id` and as the payload `id`; receivers dedupe on it. */
    eventId: text("eventId").notNull().unique(),
    eventType: text("eventType", {
      enum: ["watch.triggered", "watch.error", "watch.recovered"],
    }).notNull(),
    targetId: text("targetId").references(() => target.id, { onDelete: "set null" }),
    /** Whose secret signs the request. */
    apiClientId: text("apiClientId").references(() => apiClient.id, { onDelete: "set null" }),
    /** Encrypted copy of the watch's callback URL at enqueue time. */
    url: encryptedText("webhookDelivery.url")("url").notNull(),
    /** Exact JSON body that is signed and sent (contains no credentials). */
    payload: text("payload").notNull(),
    /** `canceled`: terminal, never sent (its API client was revoked); see api-client-revocation.ts. */
    status: text("status", { enum: ["pending", "delivered", "failed", "canceled"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** Next attempt (pending), or lease expiry while an attempt is in flight. */
    nextAttemptAt: timestamp("nextAttemptAt", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    lastAttemptAt: timestamp("lastAttemptAt", { withTimezone: true, precision: 3 }),
    lastStatusCode: integer("lastStatusCode"),
    lastError: text("lastError"),
    deliveredAt: timestamp("deliveredAt", { withTimezone: true, precision: 3 }),
    /**
     * When the delivery reached a terminal status (delivered, failed, canceled), by the
     * database clock; null while pending (a retried delivery clears it). Retention prunes
     * on this, never on createdAt (see webhook-delivery-retention.ts).
     */
    completedAt: timestamp("completedAt", { withTimezone: true, precision: 3 }),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byDue: index("webhook_delivery_due_idx").on(t.status, t.nextAttemptAt),
    byTarget: index("webhook_delivery_target_idx").on(t.targetId, t.createdAt),
    /** Revocation cancels a client's pending deliveries. */
    byClientStatus: index("webhook_delivery_client_status_idx").on(t.apiClientId, t.status),
    /** Retention pruning: oldest terminal deliveries first. Pending rows are not indexed. */
    byCompleted: index("webhook_delivery_completed_idx").on(t.completedAt).where(sql`"completedAt" IS NOT NULL`),
  }),
);

/** Additional users invited to operate on rows keyed by ownerUserId (same as website.userId for that account). */
export const accountMembership = pgTable(
  "accountMembership",
  {
    ownerUserId: text("ownerUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memberUserId: text("memberUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerUserId, t.memberUserId] }),
    byMember: index("account_membership_member_idx").on(t.memberUserId),
  }),
);

/**
 * Multi-seat time-limited invite; store only tokenHash of the opaque token shown in URL.
 * `organizationLabel` is a snapshot for auth-page copy when the invite is opened without login.
 */
export const accountInvite = pgTable(
  "accountInvite",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("ownerUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull().unique(),
    expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    createdByUserId: text("createdByUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Display name copied at invite time (website title/name or profile name); never inferred from APIs here. */
    organizationLabel: text("organizationLabel"),
    maxUses: integer("maxUses").notNull().default(5),
    useCount: integer("useCount").notNull().default(0),
    redeemedAt: timestamp("redeemedAt", { withTimezone: true, precision: 3 }),
    redeemedByUserId: text("redeemedByUserId").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    byOwner: index("account_invite_owner_idx").on(t.ownerUserId),
    byExpires: index("account_invite_expires_idx").on(t.expiresAt),
  }),
);

/**
 * Watcher API rate-limit counters (see `rate-limit.ts`): one row per (client, class,
 * window length) and window. Rows expire with their window and are deleted by the worker.
 */
export const apiRateLimit = pgTable(
  "apiRateLimit",
  {
    /** `<apiClientId>:<class>:<windowSeconds>`. */
    key: text("key").notNull(),
    windowStart: timestamp("windowStart", { withTimezone: true, precision: 3 }).notNull(),
    count: integer("count").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.windowStart] }),
    byExpiry: index("api_rate_limit_expires_idx").on(t.expiresAt),
  }),
);

export type User = typeof user.$inferSelect;
export type ApiClient = typeof apiClient.$inferSelect;
export type UserNotificationSettings = typeof userNotificationSettings.$inferSelect;
export type NotificationDestination = typeof notificationDestination.$inferSelect;
export type NotificationChannel = NotificationDestination["channel"];
export type Website = typeof website.$inferSelect;
export type Target = typeof target.$inferSelect;
export type Snapshot = typeof snapshot.$inferSelect;
export type Alert = typeof alert.$inferSelect;
export type AlertKind = Alert["kind"];
export type TargetKind = Target["kind"];
export type LinkScope = NonNullable<Target["linkScope"]>;
export type AiProvider = NonNullable<UserNotificationSettings["aiProvider"]>;
export type WebhookDelivery = typeof webhookDelivery.$inferSelect;
