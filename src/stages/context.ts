import type { InferSelectModel } from 'drizzle-orm';
import type { schema } from '../db/client.js';

export type RepoRow = InferSelectModel<typeof schema.repos>;
export type ReviewRow = InferSelectModel<typeof schema.reviews>;
export type RoundRow = InferSelectModel<typeof schema.rounds>;
export type ConcernRow = InferSelectModel<typeof schema.concerns>;

export interface Ctx {
  repo: RepoRow;
  review: ReviewRow;
  round: RoundRow | null;
  workspaceDir: string | null;
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

export function requireRound(ctx: Ctx): RoundRow {
  if (!ctx.round) throw new Error(`review ${ctx.review.id} in state ${ctx.review.state} has no current round`);
  return ctx.round;
}

export function requireWorkspace(ctx: Ctx): string {
  if (!ctx.workspaceDir) throw new Error('workspace not prepared');
  return ctx.workspaceDir;
}
