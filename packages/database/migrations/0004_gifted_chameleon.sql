CREATE TABLE "provider_observations" (
	"observation_id" varchar(66) PRIMARY KEY NOT NULL,
	"provider" varchar(64) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"request_hash" varchar(66) NOT NULL,
	"response_hash" varchar(66) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_payload" jsonb NOT NULL,
	"correlation_id" varchar(256),
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_observations_response_unique" UNIQUE("provider","operation","response_hash"),
	CONSTRAINT "provider_observations_id_format" CHECK ("provider_observations"."observation_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "provider_observations_request_hash_format" CHECK ("provider_observations"."request_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "provider_observations_response_hash_format" CHECK ("provider_observations"."response_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "provider_observations_provider_time_idx" ON "provider_observations" USING btree ("provider","observed_at");