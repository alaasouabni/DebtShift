ALTER TABLE "transport_legs" ADD COLUMN "origin_transaction_hash" varchar(66);--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "destination_transaction_hash" varchar(66);--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "observation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_observation_nonnegative" CHECK ("transport_legs"."observation_count" >= 0);