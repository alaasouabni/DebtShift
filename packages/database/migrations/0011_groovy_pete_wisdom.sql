ALTER TABLE "recovery_cases" ADD COLUMN "next_permitted_action" varchar(96);--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD COLUMN "action_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD COLUMN "escalation_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD COLUMN "escalation_state" varchar(64);--> statement-breakpoint
UPDATE "recovery_cases"
SET "policy" = 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE'
WHERE "policy" = 'DETERMINISTIC_RECOVERY_POLICY';--> statement-breakpoint
UPDATE "recovery_cases"
SET
  "next_permitted_action" = CASE
    WHEN "policy" = 'MANUAL_CUSTODY_RECONCILIATION' THEN 'RECONCILE_TRANSPORT_CUSTODY'
    WHEN "policy" = 'MANUAL_TARGET_AND_PAYOUT_RECONCILIATION' THEN 'RECONCILE_TARGET_AND_PAYOUT'
    WHEN "policy" = 'MANUAL_SETTLEMENT_RECONCILIATION' THEN 'RECONCILE_SETTLEMENT'
    WHEN "policy" = 'MANUAL_RECOVERY_EXECUTION_RECONCILIATION' THEN 'RECONCILE_RECOVERY_EXECUTION'
    WHEN "policy" = 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION' THEN 'RECONCILE_CANONICAL_STATE'
    ELSE 'EXECUTE_SIGNED_RECOVERY'
  END,
  "action_deadline" = "opened_at",
  "escalation_owner" = CASE
    WHEN "policy" LIKE 'MANUAL_%' OR "policy" LIKE 'HALT_FOR_MANUAL_%'
      THEN 'DEBTSHIFT_OPERATIONS'
    ELSE 'DEBTSHIFT_WORKER'
  END,
  "escalation_state" = CASE
    WHEN "status" = 'RESOLVED_FAILED_SAFE' THEN 'RESOLVED_FAILED_SAFE'
    WHEN "policy" LIKE 'MANUAL_%' OR "policy" LIKE 'HALT_FOR_MANUAL_%'
      THEN 'MANUAL_REVIEW_REQUIRED'
    ELSE 'AUTOMATED_RECOVERY_PENDING'
  END;--> statement-breakpoint
ALTER TABLE "recovery_cases" ALTER COLUMN "next_permitted_action" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_cases" ALTER COLUMN "action_deadline" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_cases" ALTER COLUMN "escalation_owner" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_cases" ALTER COLUMN "escalation_state" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "recovery_cases_escalation_idx" ON "recovery_cases" USING btree ("escalation_state","action_deadline");--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_action_state_consistent" CHECK (("recovery_cases"."escalation_state" = 'AUTOMATED_RECOVERY_PENDING' AND "recovery_cases"."next_permitted_action" = 'EXECUTE_SIGNED_RECOVERY') OR ("recovery_cases"."escalation_state" = 'MANUAL_REVIEW_REQUIRED' AND "recovery_cases"."next_permitted_action" <> 'EXECUTE_SIGNED_RECOVERY') OR "recovery_cases"."escalation_state" = 'RESOLVED_FAILED_SAFE');--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_status_state_consistent" CHECK (("recovery_cases"."status" = 'OPEN' AND "recovery_cases"."escalation_state" <> 'RESOLVED_FAILED_SAFE') OR ("recovery_cases"."status" = 'RESOLVED_FAILED_SAFE' AND "recovery_cases"."escalation_state" = 'RESOLVED_FAILED_SAFE'));
