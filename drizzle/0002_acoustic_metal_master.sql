CREATE TYPE "public"."round_kind" AS ENUM('full', 'verification');--> statement-breakpoint
ALTER TABLE "concerns" ADD COLUMN "gate_blocking" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "user_facing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "auto_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "kind" "round_kind" DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "round_summary" text;