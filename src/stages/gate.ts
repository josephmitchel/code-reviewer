import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { hasGateStatus, postComment, postStatus } from '../github.js';
import { formatScore } from '../scoring.js';
import { renderReport } from '../render-report.js';
import { blockingConcerns, reportData, testsLine } from './report.js';
import { MAX_ROUNDS, requireRound, type Ctx } from './context.js';

export async function runGating(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  const blocking = await blockingConcerns(ctx);
  if (blocking.length > 0 && round.roundNo < MAX_ROUNDS) {
    throw new Error(
      `gating with ${blocking.length} open blocking concern(s) before the round cap — state machine bug`,
    );
  }
  const passWithWarnings = blocking.length > 0;
  const data = await reportData(ctx, round);

  if (!(await hasGateStatus(ctx.repo.slug, round.headSha))) {
    await postStatus(
      ctx.repo.slug,
      round.headSha,
      'success',
      passWithWarnings
        ? `passed with warnings — ${blocking.length} unresolved concern(s) at the round cap`
        : `${formatScore(data.score)} — 0 open blocking concerns`,
    );
    await db.insert(schema.githubArtifacts).values({
      reviewId: ctx.review.id,
      kind: 'commit_status',
      sha: round.headSha,
      roundNo: round.roundNo,
      payload: { state: 'success', score: data.score, passWithWarnings },
    });
    console.log(`gate status posted on ${round.headSha.slice(0, 10)}${passWithWarnings ? ' (with warnings)' : ''}`);
  }

  const alreadySummarized = await db
    .select({ id: schema.githubArtifacts.id })
    .from(schema.githubArtifacts)
    .where(
      and(
        eq(schema.githubArtifacts.reviewId, ctx.review.id),
        eq(schema.githubArtifacts.kind, 'summary_comment'),
      ),
    );
  if (alreadySummarized.length === 0) {
    const body = renderReport({
      mode: 'final',
      passWithWarnings,
      roundNo: round.roundNo,
      maxRounds: MAX_ROUNDS,
      headSha: round.headSha,
      score: data.score,
      testsLine: testsLine(ctx),
      roundSummary: round.roundSummary,
      concerns: data.concerns,
      questions: data.questions,
    });
    const commentId = await postComment(ctx.repo.slug, ctx.review.prNumber, body);
    await db.insert(schema.githubArtifacts).values({
      reviewId: ctx.review.id,
      kind: 'summary_comment',
      githubId: String(commentId),
      sha: round.headSha,
      roundNo: round.roundNo,
    });
    console.log(`final summary posted (comment ${commentId})`);
  }
}
