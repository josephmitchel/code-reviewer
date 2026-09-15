import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { Ctx } from './context.js';

export type QuestionRow = typeof schema.questions.$inferSelect;

/** User-facing questions across the whole review that the owner has not answered yet. */
export async function pendingUserFacingQuestions(ctx: Ctx): Promise<QuestionRow[]> {
  const rows = await db
    .select()
    .from(schema.questions)
    .where(
      and(
        eq(schema.questions.reviewId, ctx.review.id),
        eq(schema.questions.userFacing, true),
        isNull(schema.questions.answeredAt),
      ),
    );
  return rows.sort((a, b) => a.ordinal - b.ordinal);
}

/** Concerns whose fix is held back behind an unanswered user-facing question. */
export async function heldConcernIds(ctx: Ctx): Promise<Set<number>> {
  const pending = await pendingUserFacingQuestions(ctx);
  return new Set(pending.map((q) => q.concernId).filter((id): id is number => id !== null));
}
