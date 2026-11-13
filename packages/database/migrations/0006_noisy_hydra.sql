ALTER TABLE "execution_plans" ADD COLUMN "target_lending_authorization" jsonb;
--> statement-breakpoint
UPDATE "execution_plans"
SET "target_lending_authorization" = '{"authorization":{"kind":"NONE"},"encodedAuthorization":"0x"}'::jsonb
WHERE "target_lending_authorization" IS NULL;
--> statement-breakpoint
ALTER TABLE "execution_plans" ALTER COLUMN "target_lending_authorization" SET NOT NULL;
