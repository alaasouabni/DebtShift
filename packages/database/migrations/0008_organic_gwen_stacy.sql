ALTER TABLE "ledger_entries" ADD COLUMN "component_code" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "component_id" varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "evidence_id" varchar(66) NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "basis" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_evidence_id_evidence_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("evidence_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_evidence_idx" ON "ledger_entries" USING btree ("evidence_id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_migration_component_unique" UNIQUE("migration_id","component_id");