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

/**
 * A nightly sweep: audit what landed on the default branch since the last sweep, file the
 * concerns as GitHub issues, judge the issues the owner closed. It never fixes and never gates.
 */
export const sweepState = pgEnum('sweep_state', [
  'pending',
  'intake',
  'judging',
  'answering',
  'auditing',
  'synthesizing',
  // After synthesis on purpose: a ticket judge can point at the concerns tonight's audit raised
  // inside the ticket's own PR.
  'judging_tickets',
  'publishing',
  'done',
  'failed',
]);
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
  /** Killed for exceeding its time budget. Reported to auditors as that, never as a failing test. */
  timedOut?: boolean;
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
  // The two long-lived issues the sweep keeps per repo: a rolling list of minor findings, and the
  // status page that is the owner's morning check. Created on the first sweep, edited ever after.
  digestIssueNumber: integer('digest_issue_number'),
  statusIssueNumber: integer('status_issue_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A reviewer concern the owner decided on: dismissed with `wontfix` (saved as policy when a reason
 * was given), closed by hand (final, never judged), or — from the nights before concerns were judged
 * as tickets — verified or reopened by a judge.
 */
export interface JudgedIssue {
  slug: string;
  issueNumber: number;
  verdict: 'resolved' | 'unresolved' | 'dismissed' | 'closed';
  note: string;
}

/**
 * A ticket (any issue a PR can address, the reviewer's own concerns included) that carried
 * `needs-judging` and got a verdict, or that the owner dismissed with `wontfix`.
 */
export interface JudgedTicket {
  issueNumber: number;
  title: string;
  verdict: 'solved' | 'needs_work' | 'nothing_to_judge' | 'dismissed';
  /** The merged PRs the verdict was based on. */
  prNumbers: number[];
}

/** What one sweep did, kept for the status issue and for `code-reviewer status`. */
export interface SweepSummary {
  judged: JudgedIssue[];
  /** Absent on sweeps recorded before ticket judging existed. */
  tickets?: JudgedTicket[];
  answered: number;
  /** Issues this sweep opened, by concern slug. */
  opened: Array<{ slug: string; issueNumber: number; level: string }>;
  /** Issues this sweep closed because the auditors found the concern fixed. */
  closedByAudit: Array<{ slug: string; issueNumber: number }>;
  commits: number;
}

export const sweeps = pgTable('sweeps', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id),
  branch: text('branch').notNull(),
  // The last sweep's head. The diff base...head is what this sweep audits.
  baseSha: text('base_sha').notNull(),
  // Null until intake reads the branch; the same SHA as base means nothing landed and the audit is skipped.
  headSha: text('head_sha'),
  state: sweepState('state').notNull().default('pending'),
  currentRoundId: integer('current_round_id'),
  summary: jsonb('summary').$type<SweepSummary>(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
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
  // Exactly one of these is set: a round belongs to a PR review or to a nightly sweep.
  reviewId: integer('review_id').references(() => reviews.id),
  sweepId: integer('sweep_id').references(() => sweeps.id),
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
  // The head this round's fixer actually pushed, read back from the remote after it finished —
  // never taken from what the agent claimed. It is what tells "our fix is already on the branch"
  // (so a re-entered `fixing` can skip the fixer) apart from "someone else moved the branch under
  // us" (so the stored plan is stale and must not be applied to a head it was never written for).
  fixSha: text('fix_sha'),
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
    originSweepId: integer('origin_sweep_id').references(() => sweeps.id),
    // The GitHub issue a sweep filed for this concern. Only majors and moderates get one; minors
    // live in the repo's digest issue. The owner closing it is what asks for a judge.
    issueNumber: integer('issue_number'),
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
  // Exactly one of these is set, like rounds.
  reviewId: integer('review_id').references(() => reviews.id),
  sweepId: integer('sweep_id').references(() => sweeps.id),
  roundId: integer('round_id')
    .notNull()
    .references(() => rounds.id),
  concernId: integer('concern_id').references(() => concerns.id),
  // User-facing questions: unique per review in PR mode, unique per concern in sweep mode (they
  // are numbered inside the concern's issue). 0 for auto-applied.
  ordinal: integer('ordinal').notNull(),
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
  // report_comment | summary_comment | pr_summary_comment | progress_comment | failure_comment |
  // carry_comment | commit_status
  kind: text('kind').notNull(),
  githubId: text('github_id'),
  sha: text('sha'),
  roundNo: integer('round_no'),
  payload: jsonb('payload'),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
});
