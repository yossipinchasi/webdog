ALTER TABLE "webhookDelivery" ADD COLUMN "completedAt" timestamp (3) with time zone;--> statement-breakpoint
-- Backfill terminal rows. Delivered: when it was delivered. Failed: its last attempt (the one
-- that made it terminal). Canceled rows recorded no time, so they start their retention now;
-- unknown times always err toward keeping a row longer, never toward deleting it early.
UPDATE "webhookDelivery" SET "completedAt" = CASE "status"
  WHEN 'delivered' THEN COALESCE("deliveredAt", "lastAttemptAt", now())
  WHEN 'failed' THEN COALESCE("lastAttemptAt", now())
  ELSE now() END
WHERE "status" IN ('delivered', 'failed', 'canceled') AND "completedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_delivery_completed_idx" ON "webhookDelivery" USING btree ("completedAt") WHERE "completedAt" IS NOT NULL;
