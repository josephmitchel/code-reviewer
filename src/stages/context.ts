import type { InferSelectModel } from 'drizzle-orm';
import type { schema } from '../db/client.js';

export type RepoRow = InferSelectModel<typeof schema.repos>;
export type ReviewRow = InferSelectModel<typeof schema.reviews>;
export type SweepRow = InferSelectModel<typeof schema.sweeps>;
export type RoundRow = InferSelectModel<typeof schema.rounds>;
export type ConcernRow = InferSelectModel<typeof schema.concerns>;

/**
 * What the stages shared by both modes need: a repo, the round being worked, and a checkout.
 * The audit and the synthesis run the same way whether the round belongs to a PR review or to a
 * nightly sweep; everything PR-specific (comments, answers, fixes, the gate) takes the full `Ctx`.
 */
export interface RunCtx {
  repo: RepoRow;
  round: RoundRow | null;
  workspaceDir: string | null;
}

/** A PR review in progress. */
export interface Ctx extends RunCtx {
  review: ReviewRow;
}

/** A nightly sweep in progress. */
export interface SweepCtx extends RunCtx {
  sweep: SweepRow;
}

export const AUDITOR_CHARACTERISTICS = [
  'functional-suitability',
  'performance-efficiency',
  'compatibility',
  'interaction-capability',
  'reliability',
  'security',
  'maintainability',
  'flexibility',
  'safety',
  'testing',
] as const;

/**
 * Auditors run in parallel, one Claude Code subprocess each. Ten suits a laptop; a small CI
 * runner sharing its memory with the reviewed repo's test suite may not, so the ceiling is
 * settable without a code change.
 */
export const AGENT_CONCURRENCY = positiveIntEnv('REVIEWER_AGENT_CONCURRENCY', 10);

/** Reads a positive integer from the environment, ignoring anything that is not one. */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.warn(`${name}=${raw} is not a positive integer — using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Hard cap on rounds per review; at the cap the gate passes with warnings instead of looping. */
export const MAX_ROUNDS = 3;

export function requireRound(ctx: RunCtx): RoundRow {
  if (!ctx.round) {
    const owner =
      'review' in ctx
        ? `review ${(ctx as Ctx).review.id} in state ${(ctx as Ctx).review.state}`
        : 'sweep' in ctx
          ? `sweep ${(ctx as SweepCtx).sweep.id} in state ${(ctx as SweepCtx).sweep.state}`
          : 'run';
    throw new Error(`${owner} has no current round`);
  }
  return ctx.round;
}

export function requireWorkspace(ctx: RunCtx): string {
  if (!ctx.workspaceDir) throw new Error('workspace not prepared');
  return ctx.workspaceDir;
}
