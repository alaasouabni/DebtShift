CREATE TYPE "public"."account_type" AS ENUM('EOA', 'EIP1271');--> statement-breakpoint
CREATE TYPE "public"."action_finality" AS ENUM('CREATED', 'SUBMITTED', 'MINED', 'CONFIRMED', 'FINALIZED', 'REVERTED', 'REORGED');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('PENDING', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."evidence_verification_state" AS ENUM('PROVISIONAL', 'CONFIRMED', 'FINALIZED', 'RETRACTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."migration_phase" AS ENUM('DRAFT', 'QUOTED', 'AUTHORIZED', 'RESERVED', 'SOURCE_CLOSED', 'ROUTING', 'DEST_FUNDED', 'TARGET_OPEN', 'SETTLED', 'COMPLETED', 'RECOVERY', 'FAILED_SAFE', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED_RETRYABLE', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('PENDING', 'ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "asset_catalog_versions" (
	"catalog_hash" varchar(66) PRIMARY KEY NOT NULL,
	"provider" varchar(64) NOT NULL,
	"environment" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"raw_response_hash" varchar(66) NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_catalog_provider_hash_unique" UNIQUE("provider","catalog_hash"),
	CONSTRAINT "asset_catalog_schema_positive" CHECK ("asset_catalog_versions"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"event_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"sequence" integer NOT NULL,
	"type" varchar(128) NOT NULL,
	"phase" "migration_phase" NOT NULL,
	"actor" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(66) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_migration_sequence_unique" UNIQUE("migration_id","sequence"),
	CONSTRAINT "audit_events_sequence_positive" CHECK ("audit_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "chain_actions" (
	"action_id" varchar(66) PRIMARY KEY NOT NULL,
	"command_id" varchar(66) NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"action_type" varchar(64) NOT NULL,
	"action_key" varchar(256) NOT NULL,
	"transaction_hash" varchar(66),
	"nonce" numeric(78, 0),
	"finality" "action_finality" DEFAULT 'CREATED' NOT NULL,
	"block_number" numeric(78, 0),
	"block_hash" varchar(66),
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_actions_key_unique" UNIQUE("chain_id","action_key"),
	CONSTRAINT "chain_actions_block_pair" CHECK (("chain_actions"."block_number" IS NULL) = ("chain_actions"."block_hash" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"command_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"type" varchar(64) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"status" "command_status" DEFAULT 'PENDING' NOT NULL,
	"logical_attempt" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(66) NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commands_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "commands_attempt_nonnegative" CHECK ("commands"."logical_attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"evidence_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"type" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"provider" varchar(128) NOT NULL,
	"network" varchar(128) NOT NULL,
	"chain_id" numeric(78, 0),
	"block_number" numeric(78, 0),
	"block_hash" varchar(66),
	"transaction_hash" varchar(66),
	"log_index" integer,
	"provider_reference" varchar(256),
	"raw_observation_hash" varchar(66) NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"verification_state" "evidence_verification_state" NOT NULL,
	"verification_method" varchar(128) NOT NULL,
	"verifier_version" varchar(64) NOT NULL,
	"supersedes_evidence_id" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_provider_reference_unique" UNIQUE("provider","network","provider_reference"),
	CONSTRAINT "evidence_schema_version_positive" CHECK ("evidence"."schema_version" > 0),
	CONSTRAINT "evidence_log_index_nonnegative" CHECK ("evidence"."log_index" IS NULL OR "evidence"."log_index" >= 0),
	CONSTRAINT "evidence_block_pair" CHECK (("evidence"."block_number" IS NULL) = ("evidence"."block_hash" IS NULL)),
	CONSTRAINT "evidence_log_requires_transaction" CHECK ("evidence"."log_index" IS NULL OR "evidence"."transaction_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"plan_hash" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"intent_hash" varchar(66) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"deadline" numeric(78, 0) NOT NULL,
	"route_hash" varchar(66) NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_plans_migration_unique" UNIQUE("migration_id"),
	CONSTRAINT "execution_plans_intent_nonce_unique" UNIQUE("intent_hash","nonce"),
	CONSTRAINT "execution_plans_hash_format" CHECK ("execution_plans"."plan_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "execution_plans_migration_format" CHECK ("execution_plans"."migration_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "execution_plans_route_format" CHECK ("execution_plans"."route_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "execution_plans_nonce_uint" CHECK ("execution_plans"."nonce" >= 0),
	CONSTRAINT "execution_plans_deadline_uint" CHECK ("execution_plans"."deadline" > 0)
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"intent_hash" varchar(66) PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"expiration" numeric(78, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intents_wallet_nonce_unique" UNIQUE("wallet_id","nonce"),
	CONSTRAINT "intents_hash_format" CHECK ("intents"."intent_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "intents_nonce_uint" CHECK ("intents"."nonce" >= 0),
	CONSTRAINT "intents_expiration_uint" CHECK ("intents"."expiration" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"entry_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"sequence" integer NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"token" varchar(42) NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"debit_party" varchar(128) NOT NULL,
	"credit_party" varchar(128) NOT NULL,
	"category" varchar(32) NOT NULL,
	"transaction_reference" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_migration_sequence_unique" UNIQUE("migration_id","sequence"),
	CONSTRAINT "ledger_entries_sequence_positive" CHECK ("ledger_entries"."sequence" > 0),
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount_units" > 0),
	CONSTRAINT "ledger_entries_distinct_parties" CHECK ("ledger_entries"."debit_party" <> "ledger_entries"."credit_party")
);
--> statement-breakpoint
CREATE TABLE "liquidity_reservations" (
	"reservation_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"reservation_hash" varchar(66) NOT NULL,
	"provider" varchar(42) NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"asset" varchar(42) NOT NULL,
	"principal_units" numeric(78, 0) NOT NULL,
	"fee_cap_units" numeric(78, 0) NOT NULL,
	"status" "reservation_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liquidity_reservations_migration_unique" UNIQUE("migration_id"),
	CONSTRAINT "liquidity_reservations_hash_unique" UNIQUE("reservation_hash"),
	CONSTRAINT "liquidity_reservations_principal_positive" CHECK ("liquidity_reservations"."principal_units" > 0),
	CONSTRAINT "liquidity_reservations_fee_uint" CHECK ("liquidity_reservations"."fee_cap_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"snapshot_id" varchar(66) PRIMARY KEY NOT NULL,
	"market_pk" uuid NOT NULL,
	"block_number" numeric(78, 0) NOT NULL,
	"block_hash" varchar(66) NOT NULL,
	"borrow_apr_ray" numeric(78, 0) NOT NULL,
	"available_liquidity_units" numeric(78, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	"raw_response_hash" varchar(66) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_snapshots_market_block_unique" UNIQUE("market_pk","block_number","block_hash"),
	CONSTRAINT "market_snapshots_block_uint" CHECK ("market_snapshots"."block_number" >= 0),
	CONSTRAINT "market_snapshots_apr_uint" CHECK ("market_snapshots"."borrow_apr_ray" >= 0),
	CONSTRAINT "market_snapshots_liquidity_uint" CHECK ("market_snapshots"."available_liquidity_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"market_pk" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"protocol" varchar(64) NOT NULL,
	"deployment" varchar(42) NOT NULL,
	"market_id" varchar(256) NOT NULL,
	"debt_asset" jsonb NOT NULL,
	"collateral_asset" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_identity_unique" UNIQUE("chain_id","protocol","deployment","market_id"),
	CONSTRAINT "markets_chain_id_uint" CHECK ("markets"."chain_id" > 0),
	CONSTRAINT "markets_deployment_format" CHECK ("markets"."deployment" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "migrations" (
	"migration_id" varchar(66) PRIMARY KEY NOT NULL,
	"intent_hash" varchar(66) NOT NULL,
	"plan_hash" varchar(66) NOT NULL,
	"quote_hash" varchar(66) NOT NULL,
	"phase" "migration_phase" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migrations_intent_unique" UNIQUE("intent_hash"),
	CONSTRAINT "migrations_plan_unique" UNIQUE("plan_hash"),
	CONSTRAINT "migrations_id_format" CHECK ("migrations"."migration_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "migrations_version_nonnegative" CHECK ("migrations"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"outbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" varchar(66) NOT NULL,
	"topic" varchar(128) NOT NULL,
	"partition_key" varchar(256) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_command_unique" UNIQUE("command_id"),
	CONSTRAINT "outbox_attempt_nonnegative" CHECK ("outbox_messages"."publish_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "position_snapshots" (
	"snapshot_id" varchar(66) PRIMARY KEY NOT NULL,
	"position_id" varchar(66) NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"block_number" numeric(78, 0) NOT NULL,
	"block_hash" varchar(66) NOT NULL,
	"debt_units" numeric(78, 0) NOT NULL,
	"collateral_units" numeric(78, 0) NOT NULL,
	"health_factor_wad" numeric(78, 0),
	"ltv_bps" integer,
	"payload" jsonb NOT NULL,
	"raw_response_hash" varchar(66) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_snapshots_position_block_unique" UNIQUE("position_id","block_number","block_hash"),
	CONSTRAINT "position_snapshots_chain_uint" CHECK ("position_snapshots"."chain_id" > 0),
	CONSTRAINT "position_snapshots_block_uint" CHECK ("position_snapshots"."block_number" >= 0),
	CONSTRAINT "position_snapshots_debt_uint" CHECK ("position_snapshots"."debt_units" >= 0),
	CONSTRAINT "position_snapshots_collateral_uint" CHECK ("position_snapshots"."collateral_units" >= 0),
	CONSTRAINT "position_snapshots_ltv_bps" CHECK ("position_snapshots"."ltv_bps" IS NULL OR ("position_snapshots"."ltv_bps" >= 0 AND "position_snapshots"."ltv_bps" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"position_id" varchar(66) PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"market_pk" uuid NOT NULL,
	"protocol_position_id" varchar(256) NOT NULL,
	"latest_snapshot_id" varchar(66),
	"active" boolean DEFAULT true NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_market_protocol_id_unique" UNIQUE("market_pk","protocol_position_id"),
	CONSTRAINT "positions_id_format" CHECK ("positions"."position_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "positions_latest_snapshot_format" CHECK ("positions"."latest_snapshot_id" IS NULL OR "positions"."latest_snapshot_id" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "provider_quotes" (
	"quote_hash" varchar(66) PRIMARY KEY NOT NULL,
	"quote_id" varchar(256) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"mode" varchar(32) NOT NULL,
	"amount_in_units" numeric(78, 0) NOT NULL,
	"expected_amount_out_units" numeric(78, 0) NOT NULL,
	"minimum_amount_out_units" numeric(78, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	"raw_response_hash" varchar(66) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_quotes_provider_id_unique" UNIQUE("provider","quote_id"),
	CONSTRAINT "provider_quotes_input_positive" CHECK ("provider_quotes"."amount_in_units" > 0),
	CONSTRAINT "provider_quotes_output_positive" CHECK ("provider_quotes"."expected_amount_out_units" > 0),
	CONSTRAINT "provider_quotes_min_positive" CHECK ("provider_quotes"."minimum_amount_out_units" > 0),
	CONSTRAINT "provider_quotes_min_lte_expected" CHECK ("provider_quotes"."minimum_amount_out_units" <= "provider_quotes"."expected_amount_out_units")
);
--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"recovery_id" varchar(66) PRIMARY KEY NOT NULL,
	"migration_id" varchar(66) NOT NULL,
	"policy" varchar(128) NOT NULL,
	"status" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"residual_assets" jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_cases_migration_unique" UNIQUE("migration_id")
);
--> statement-breakpoint
CREATE TABLE "transport_legs" (
	"migration_id" varchar(66) NOT NULL,
	"leg_index" integer NOT NULL,
	"provider" varchar(64) NOT NULL,
	"quote_hash" varchar(66) NOT NULL,
	"input_asset" jsonb NOT NULL,
	"output_asset" jsonb NOT NULL,
	"input_units" numeric(78, 0) NOT NULL,
	"minimum_output_units" numeric(78, 0) NOT NULL,
	"provider_state" varchar(64) NOT NULL,
	"provider_reference" varchar(256),
	"deposit_address" text,
	"refund_transaction_hash" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_legs_migration_id_leg_index_pk" PRIMARY KEY("migration_id","leg_index"),
	CONSTRAINT "transport_legs_index_nonnegative" CHECK ("transport_legs"."leg_index" >= 0),
	CONSTRAINT "transport_legs_input_positive" CHECK ("transport_legs"."input_units" > 0),
	CONSTRAINT "transport_legs_output_positive" CHECK ("transport_legs"."minimum_output_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"wallet_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"address" varchar(42) NOT NULL,
	"account_type" "account_type" NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_chain_address_unique" UNIQUE("chain_id","address"),
	CONSTRAINT "wallets_chain_id_uint" CHECK ("wallets"."chain_id" > 0),
	CONSTRAINT "wallets_address_format" CHECK ("wallets"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_actions" ADD CONSTRAINT "chain_actions_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_actions" ADD CONSTRAINT "chain_actions_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD CONSTRAINT "execution_plans_intent_hash_intents_intent_hash_fk" FOREIGN KEY ("intent_hash") REFERENCES "public"."intents"("intent_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_wallet_id_wallets_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("wallet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liquidity_reservations" ADD CONSTRAINT "liquidity_reservations_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_market_pk_markets_market_pk_fk" FOREIGN KEY ("market_pk") REFERENCES "public"."markets"("market_pk") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_intent_hash_intents_intent_hash_fk" FOREIGN KEY ("intent_hash") REFERENCES "public"."intents"("intent_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_plan_hash_execution_plans_plan_hash_fk" FOREIGN KEY ("plan_hash") REFERENCES "public"."execution_plans"("plan_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_quote_hash_provider_quotes_quote_hash_fk" FOREIGN KEY ("quote_hash") REFERENCES "public"."provider_quotes"("quote_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_snapshots" ADD CONSTRAINT "position_snapshots_position_id_positions_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("position_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_wallet_id_wallets_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("wallet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_pk_markets_market_pk_fk" FOREIGN KEY ("market_pk") REFERENCES "public"."markets"("market_pk") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_migration_id_migrations_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("migration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_migration_observed_idx" ON "audit_events" USING btree ("migration_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_actions_transaction_unique" ON "chain_actions" USING btree ("chain_id","transaction_hash") WHERE "chain_actions"."transaction_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chain_actions_migration_idx" ON "chain_actions" USING btree ("migration_id","created_at");--> statement-breakpoint
CREATE INDEX "commands_ready_idx" ON "commands" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "commands_migration_idx" ON "commands" USING btree ("migration_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_chain_log_unique" ON "evidence" USING btree ("chain_id","transaction_hash","log_index","type") WHERE "evidence"."chain_id" IS NOT NULL AND "evidence"."transaction_hash" IS NOT NULL AND "evidence"."log_index" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "evidence_migration_type_state_idx" ON "evidence" USING btree ("migration_id","type","verification_state");--> statement-breakpoint
CREATE INDEX "ledger_entries_balance_idx" ON "ledger_entries" USING btree ("migration_id","chain_id","token");--> statement-breakpoint
CREATE INDEX "market_snapshots_market_observed_idx" ON "market_snapshots" USING btree ("market_pk","observed_at");--> statement-breakpoint
CREATE INDEX "migrations_phase_updated_idx" ON "migrations" USING btree ("phase","updated_at");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_messages" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "position_snapshots_position_observed_idx" ON "position_snapshots" USING btree ("position_id","observed_at");