import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const reviewState = pgEnum('review_state', [
  'pending',
  'intake',
  'auditing',
  'synthesizing',
  'reporting',
  'awaiting_answers',
  'fix_planning',
  'fixing',
  'judging',
  'gating',
  'passed',
  'failed',
]);

export const roundKind = pgEnum('round_kind', ['full', 'verification']);
export const concernLevel = pgEnum('concern_level', ['major', 'moderate', 'minor']);
export const concernStatus = pgEnum('concern_status', ['open', 'resolved']);
export const sessionStatus = pgEnum('session_status', ['running', 'succeeded', 'failed']);

export interface TestCommand {
  name: string;
  command: string;
}

export interface TestResult {
  name: string;
  command: string;
  passed: boolean;
  ranAt: string;
  trimmedOutput: string | null;
}

export interface BlastRadiusFile {
  path: string;
  reason: string;
}

export interface ConcernLocation {
  file: string;
  line: number | null;
}

export interface FixPlanStep {
  concernSlug: string;
  approach: string;
  files: string[];
}

export interface FixPlan {
  steps: FixPlanStep[];
  commitMessage: string;
}

export const repos = pgTable('repos', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(), // owner/name
  cloneUrl: text('clone_url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  setupCommand: text('setup_command'),
  testCommands: jsonb('test_commands').$type<TestCommand[]>().notNull().default([]),
  redundancy: integer('redundancy').notNull().default(1),
  harnessNotes: text('harness_notes'),
  extraContext: text('extra_context'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reviews = pgTable(
  'reviews',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id),
    prNumber: integer('pr_number').notNull(),
    prBranch: text('pr_branch').notNull(),
    state: reviewState('state').notNull().default('pending'),
    currentRoundId: integer('current_round_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reviews_repo_pr_idx').on(t.repoId, t.prNumber)],
);

export const rounds = pgTable('rounds', {
  id: serial('id').primaryKey(),
  reviewId: integer('review_id')
    .notNull()
    .references(() => reviews.id),
  roundNo: integer('round_no').notNull(),
  // 'full': audit the whole PR diff. 'verification': audit only the previous round's fix diff.
  kind: roundKind('kind').notNull().default('full'),
  headSha: text('head_sha').notNull(),
  baseSha: text('base_sha').notNull(),
  blastRadius: jsonb('blast_radius').$type<BlastRadiusFile[]>(),
  prSummary: text('pr_summary'),
  roundSummary: text('round_summary'),
  testResults: jsonb('test_results').$type<TestResult[]>(),
  reportCommentId: bigint('report_comment_id', { mode: 'number' }),
  synthesizedAt: timestamp('synthesized_at', { withTimezone: true }),
  plan: jsonb('plan').$type<FixPlan>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const concerns = pgTable(
  'concerns',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id),
    // Nullable: concerns outlive their review (reset deletes the review but keeps concerns).
    originReviewId: integer('origin_review_id').references(() => reviews.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    level: concernLevel('level').notNull(),
    status: concernStatus('status').notNull().default('open'),
    characteristics: text('characteristics').array().notNull(), // first entry = primary
    locations: jsonb('locations').$type<ConcernLocation[]>().notNull().default([]),
    // Set once at creation: full-round creates always block the gate; verification-round
    // creates block only when they are major regressions introduced by the fix commits.
    gateBlocking: boolean('gate_blocking').notNull().default(true),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenRoundId: integer('last_seen_round_id').references(() => rounds.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
  },
  (t) => [uniqueIndex('concerns_repo_slug_idx').on(t.repoId, t.slug)],
);

export const findings = pgTable('findings', {
  id: serial('id').primaryKey(),
  roundId: integer('round_id')
    .notNull()
    .references(() => rounds.id),
  auditor: text('auditor').notNull(),
  agentSessionId: integer('agent_session_id'),
  payload: jsonb('payload').notNull(),
  concernId: integer('concern_id').references(() => concerns.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const questions = pgTable('questions', {
  id: serial('id').primaryKey(),
  reviewId: integer('review_id')
    .notNull()
    .references(() => reviews.id),
  roundId: integer('round_id')
    .notNull()
    .references(() => rounds.id),
  concernId: integer('concern_id').references(() => concerns.id),
  ordinal: integer('ordinal').notNull(), // unique per review for user-facing questions; 0 for auto-applied
  text: text('text').notNull(),
  recommendation: text('recommendation'),
  // Only questions about user-facing UI/functionality changes wait for the owner;
  // everything else gets its recommendation applied automatically at synthesis time.
  userFacing: boolean('user_facing').notNull().default(false),
  autoApplied: boolean('auto_applied').notNull().default(false),
  answer: text('answer'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  sourceCommentId: bigint('source_comment_id', { mode: 'number' }),
});

export const policies = pgTable('policies', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  sourceReviewId: integer('source_review_id').references(() => reviews.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentSessions = pgTable('agent_sessions', {
  id: serial('id').primaryKey(),
  roundId: integer('round_id')
    .notNull()
    .references(() => rounds.id),
  role: text('role').notNull(), // auditor-security | scout | synthesis | fix-planner | fixer | judge:<slug>
  sdkSessionId: text('sdk_session_id'),
  status: sessionStatus('status').notNull().default('running'),
  result: jsonb('result'),
  usage: jsonb('usage'),
  isError: boolean('is_error').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const githubArtifacts = pgTable('github_artifacts', {
  id: serial('id').primaryKey(),
  reviewId: integer('review_id')
    .notNull()
    .references(() => reviews.id),
  kind: text('kind').notNull(), // report_comment | commit_status | summary_comment
  githubId: text('github_id'),
  sha: text('sha'),
  roundNo: integer('round_no'),
  payload: jsonb('payload'),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
});
