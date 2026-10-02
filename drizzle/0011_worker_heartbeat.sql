CREATE TABLE "workerHeartbeat" (
	"loop" text PRIMARY KEY NOT NULL,
	"lastStartedAt" timestamp (3) with time zone,
	"lastSuccessAt" timestamp (3) with time zone,
	"lastFailureAt" timestamp (3) with time zone,
	"dueBy" timestamp (3) with time zone,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL
);
