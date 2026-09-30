ALTER TABLE "alert" ADD COLUMN "conditionStatus" text;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "conditionReason" text;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "conditionEvidence" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "condition" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "triggerMode" text DEFAULT 'every' NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "triggeredAt" timestamp (3) with time zone;