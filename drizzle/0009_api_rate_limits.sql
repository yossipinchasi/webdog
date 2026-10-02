CREATE TABLE "apiRateLimit" (
	"key" text NOT NULL,
	"windowStart" timestamp (3) with time zone NOT NULL,
	"count" integer NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "apiRateLimit_key_windowStart_pk" PRIMARY KEY("key","windowStart")
);
--> statement-breakpoint
CREATE INDEX "api_rate_limit_expires_idx" ON "apiRateLimit" USING btree ("expiresAt");