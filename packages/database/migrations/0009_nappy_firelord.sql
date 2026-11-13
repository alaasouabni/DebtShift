CREATE TYPE "public"."operational_alert_severity" AS ENUM('WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."operational_alert_status" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "operational_alerts" (
	"alert_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"type" varchar(96) NOT NULL,
	"severity" "operational_alert_severity" NOT NULL,
	"deduplication_key" varchar(256) NOT NULL,
	"status" "operational_alert_status" DEFAULT 'OPEN' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_alerts_deduplication_unique" UNIQUE("deduplication_key"),
	CONSTRAINT "operational_alerts_id_format" CHECK ("operational_alerts"."alert_id" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operational_alerts_open_idx" ON "operational_alerts" USING btree ("status","severity","last_observed_at");--> statement-breakpoint
CREATE INDEX "operational_alerts_migration_idx" ON "operational_alerts" USING btree ("migration_id","created_at");