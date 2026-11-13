CREATE TABLE "wallet_auth_challenges" (
	"challenge_id" uuid PRIMARY KEY NOT NULL,
	"wallet_address" varchar(42) NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_auth_challenges_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "wallet_auth_challenges_chain_uint" CHECK ("wallet_auth_challenges"."chain_id" > 0),
	CONSTRAINT "wallet_auth_challenges_address_format" CHECK ("wallet_auth_challenges"."wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "wallet_auth_challenges_nonce_format" CHECK ("wallet_auth_challenges"."nonce" ~ '^[a-zA-Z0-9]{8,64}$'),
	CONSTRAINT "wallet_auth_challenges_message_nonempty" CHECK (length("wallet_auth_challenges"."message") > 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_sessions" (
	"session_hash" varchar(66) PRIMARY KEY NOT NULL,
	"wallet_address" varchar(42) NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_sessions_hash_format" CHECK ("wallet_sessions"."session_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "wallet_sessions_chain_uint" CHECK ("wallet_sessions"."chain_id" > 0),
	CONSTRAINT "wallet_sessions_address_format" CHECK ("wallet_sessions"."wallet_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX "wallet_auth_challenges_wallet_expiry_idx" ON "wallet_auth_challenges" USING btree ("wallet_address","expires_at");--> statement-breakpoint
CREATE INDEX "wallet_sessions_wallet_expiry_idx" ON "wallet_sessions" USING btree ("wallet_address","expires_at");