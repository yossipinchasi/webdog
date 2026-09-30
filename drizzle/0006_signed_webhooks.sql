CREATE TABLE "webhookDelivery" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"eventType" text NOT NULL,
	"targetId" text,
	"apiClientId" text,
	"url" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lastAttemptAt" timestamp (3) with time zone,
	"lastStatusCode" integer,
	"lastError" text,
	"deliveredAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhookDelivery_eventId_unique" UNIQUE("eventId")
);
--> statement-breakpoint
ALTER TABLE "apiClient" ADD COLUMN "webhookSecret" text DEFAULT ('whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')) NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "callbackUrl" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "consecutiveFailures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "failingSince" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "webhookDelivery" ADD CONSTRAINT "webhookDelivery_targetId_target_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhookDelivery" ADD CONSTRAINT "webhookDelivery_apiClientId_apiClient_id_fk" FOREIGN KEY ("apiClientId") REFERENCES "public"."apiClient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_due_idx" ON "webhookDelivery" USING btree ("status","nextAttemptAt");--> statement-breakpoint
CREATE INDEX "webhook_delivery_target_idx" ON "webhookDelivery" USING btree ("targetId","createdAt");--> statement-breakpoint
-- API watches created before signed webhooks routed their callbackUrl through a WEBHOOK
-- notification destination (unsigned `webdog_ai.new_alerts` payload). Move that URL onto the
-- watch, where the outbox delivers signed `watch.*` events, and detach the destination so the
-- same change is not also sent in the old format. Dashboard monitors are untouched.
UPDATE "target" AS t
SET "callbackUrl" = d."alertWebhookUrl", "externalNotify" = false, "notificationDestinationId" = NULL
FROM "notificationDestination" AS d
WHERE t."apiClientId" IS NOT NULL
  AND t."externalNotify" = true
  AND t."notificationDestinationId" = d."id"
  AND d."channel" = 'WEBHOOK'
  AND d."alertWebhookUrl" IS NOT NULL;
