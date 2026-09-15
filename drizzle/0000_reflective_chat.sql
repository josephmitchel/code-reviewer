CREATE TYPE "public"."concern_level" AS ENUM('major', 'moderate', 'minor');--> statement-breakpoint
CREATE TYPE "public"."concern_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('pending', 'intake', 'auditing', 'synthesizing', 'reporting', 'awaiting_answers', 'fix_planning', 'fixing', 'judging', 'gating', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"role" text NOT NULL,
	"sdk_session_id" text,
	"status" "session_status" DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"usage" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "concerns" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"origin_review_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"level" "concern_level" NOT NULL,
	"status" "concern_status" DEFAULT 'open' NOT NULL,
	"characteristics" text[] NOT NULL,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_round_id" integer,
	"resolved_at" timestamp with time zone,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"auditor" text NOT NULL,
	"agent_session_id" integer,
	"payload" jsonb NOT NULL,
	"concern_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"kind" text NOT NULL,
	"github_id" text,
	"sha" text,
	"round_no" integer,
	"payload" jsonb,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_review_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"round_id" integer NOT NULL,
	"concern_id" integer,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"source_comment_id" bigint
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"clone_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"setup_command" text,
	"test_commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redundancy" integer DEFAULT 1 NOT NULL,
	"harness_notes" text,
	"extra_context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_branch" text NOT NULL,
	"state" "review_state" DEFAULT 'pending' NOT NULL,
	"current_round_id" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"round_no" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"blast_radius" jsonb,
	"test_results" jsonb,
	"report_comment_id" bigint,
	"synthesized_at" timestamp with time zone,
	"plan" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concerns" ADD CONSTRAINT "concerns_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concerns" ADD CONSTRAINT "concerns_origin_review_id_reviews_id_fk" FOREIGN KEY ("origin_review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concerns" ADD CONSTRAINT "concerns_last_seen_round_id_rounds_id_fk" FOREIGN KEY ("last_seen_round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_concern_id_concerns_id_fk" FOREIGN KEY ("concern_id") REFERENCES "public"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_artifacts" ADD CONSTRAINT "github_artifacts_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_source_review_id_reviews_id_fk" FOREIGN KEY ("source_review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_concern_id_concerns_id_fk" FOREIGN KEY ("concern_id") REFERENCES "public"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concerns_repo_slug_idx" ON "concerns" USING btree ("repo_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_repo_pr_idx" ON "reviews" USING btree ("repo_id","pr_number");