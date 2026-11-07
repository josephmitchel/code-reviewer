CREATE TYPE "public"."sweep_state" AS ENUM('pending', 'intake', 'judging', 'answering', 'auditing', 'synthesizing', 'publishing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "sweeps" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text,
	"state" "sweep_state" DEFAULT 'pending' NOT NULL,
	"current_round_id" integer,
	"summary" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "review_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ALTER COLUMN "review_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "concerns" ADD COLUMN "origin_sweep_id" integer;--> statement-breakpoint
ALTER TABLE "concerns" ADD COLUMN "issue_number" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "sweep_id" integer;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "digest_issue_number" integer;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "status_issue_number" integer;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "sweep_id" integer;--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concerns" ADD CONSTRAINT "concerns_origin_sweep_id_sweeps_id_fk" FOREIGN KEY ("origin_sweep_id") REFERENCES "public"."sweeps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_sweep_id_sweeps_id_fk" FOREIGN KEY ("sweep_id") REFERENCES "public"."sweeps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_sweep_id_sweeps_id_fk" FOREIGN KEY ("sweep_id") REFERENCES "public"."sweeps"("id") ON DELETE no action ON UPDATE no action;