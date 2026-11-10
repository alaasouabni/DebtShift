ALTER TYPE "public"."reservation_status" ADD VALUE 'DRAWN' BEFORE 'RELEASED';--> statement-breakpoint
ALTER TYPE "public"."reservation_status" ADD VALUE 'SETTLED' BEFORE 'RELEASED';