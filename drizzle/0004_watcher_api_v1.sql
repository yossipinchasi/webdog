CREATE TABLE "apiClient" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerUserId" text NOT NULL,
	"name" text NOT NULL,
	"keyPrefix" text NOT NULL,
	"keyHash" text NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp (3) with time zone,
	"revokedAt" timestamp (3) with time zone,
	CONSTRAINT "apiClient_keyHash_unique" UNIQUE("keyHash")
);
--> statement-breakpoint
ALTER TABLE "snapshot" ADD COLUMN "targetId" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "apiClientId" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "externalUserId" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "externalRef" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "apiClient" ADD CONSTRAINT "apiClient_ownerUserId_user_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_client_owner_idx" ON "apiClient" USING btree ("ownerUserId");--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_targetId_target_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target" ADD CONSTRAINT "target_apiClientId_apiClient_id_fk" FOREIGN KEY ("apiClientId") REFERENCES "public"."apiClient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshot_target_idx" ON "snapshot" USING btree ("targetId","createdAt");--> statement-breakpoint
CREATE INDEX "target_external_user_idx" ON "target" USING btree ("externalUserId");--> statement-breakpoint
CREATE UNIQUE INDEX "target_api_client_external_ref_idx" ON "target" USING btree ("apiClientId","externalRef") WHERE "externalRef" IS NOT NULL;--> statement-breakpoint
-- Backfill: attach existing snapshots to the monitor they were the baseline for. Until now a
-- website could hold at most one monitor per (kind, page URL), so each row matches at most one
-- monitor. Rows with no match (their monitor was deleted) stay NULL.
UPDATE "snapshot" AS s SET "targetId" = t."id"
FROM "target" AS t
WHERE s."targetId" IS NULL
  AND s."websiteId" = t."websiteId"
  AND (
    (s."kind" = 'MARKDOWN' AND t."kind" = 'PAGE_CONTENT' AND s."targetUrl" = t."pageUrl")
    OR (s."kind" = 'PRODUCT' AND t."kind" = 'PRODUCT_PRICE' AND s."targetUrl" = t."pageUrl")
    OR (s."kind" = 'SITEMAP' AND t."kind" = 'SITEMAP_LINKS' AND s."targetUrl" IS NULL)
  );
