import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { postComment, updateComment } from '../github.js';
import { requireRound, type Ctx } from './context.js';

/**
 * The PR Summary lives in its own comment — the first one posted on the PR. A re-review
 * (new full round, new head) edits that comment in place rather than posting another.
 */
export async function ensurePrSummaryComment(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  if (!round.prSummary) return;

  const [existing] = await db
    .select()
    .from(schema.githubArtifacts)
    .where(
      and(
        eq(schema.githubArtifacts.reviewId, ctx.review.id),
        eq(schema.githubArtifacts.kind, 'pr_summary_comment'),
      ),
    );

  const body = `# PR Summary\n\n${round.prSummary.trim()}`;
  if (!existing) {
    const commentId = await postComment(ctx.repo.slug, ctx.review.prNumber, body);
    await db.insert(schema.githubArtifacts).values({
      reviewId: ctx.review.id,
      kind: 'pr_summary_comment',
      githubId: String(commentId),
      sha: round.headSha,
      roundNo: round.roundNo,
    });
    console.log(`PR summary posted (comment ${commentId})`);
  } else if (round.kind === 'full' && existing.sha !== round.headSha) {
    // Verification rounds only carry the summary forward; a full round on a new head means
    // a re-review produced a fresh summary.
    await updateComment(ctx.repo.slug, Number(existing.githubId), body);
    await db
      .update(schema.githubArtifacts)
      .set({ sha: round.headSha, roundNo: round.roundNo, postedAt: new Date() })
      .where(eq(schema.githubArtifacts.id, existing.id));
    console.log(`PR summary updated (comment ${existing.githubId})`);
  }
}
