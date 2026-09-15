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

export const AGENT_CONCURRENCY = 10;

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
