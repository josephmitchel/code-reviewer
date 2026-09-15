import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { postComment } from '../github.js';
import { renderReport, type ReportConcern, type ReportQuestion } from '../render-report.js';
import { scoreConcerns } from '../scoring.js';
import { pendingUserFacingQuestions } from './questions.js';
import { MAX_ROUNDS, requireRound, type Ctx, type ConcernRow, type RoundRow } from './context.js';

/**
 * Whether a concern counts against this review's gate: open, non-minor, created by this
 * review (pre-existing repo debt never blocks a PR that merely touches its files), and
 * gateBlocking (verification-round creates only block when they are fix-introduced majors).
 */
export function isBlocking(c: ConcernRow, reviewId: number): boolean {
  return c.status === 'open' && c.level !== 'minor' && c.originReviewId === reviewId && c.gateBlocking;
}

export async function blockingConcerns(ctx: Ctx): Promise<ConcernRow[]> {
  return (await reviewConcerns(ctx)).filter((c) => isBlocking(c, ctx.review.id));
}

/** Concerns examined during this review (seen in any of its rounds). */
export async function reviewConcerns(ctx: Ctx): Promise<ConcernRow[]> {
  const roundIds = (
    await db
      .select({ id: schema.rounds.id })
      .from(schema.rounds)
      .where(eq(schema.rounds.reviewId, ctx.review.id))
  ).map((r) => r.id);
  if (roundIds.length === 0) return [];
  return db
    .select()
    .from(schema.concerns)
    .where(inArray(schema.concerns.lastSeenRoundId, roundIds));
}

export function testsLine(ctx: Ctx): string {
  const results = ctx.round?.testResults ?? [];
  if (results.length === 0) return 'no suites configured';
  const failed = results.filter((r) => !r.passed);
  return failed.length === 0
    ? `${results.length}/${results.length} suites pass`
    : `${failed.length} of ${results.length} suites FAIL (${failed.map((f) => f.name).join(', ')})`;
}

/** Everything the renderer needs about the review's current concern/question state. */
export async function reportData(ctx: Ctx, round: RoundRow): Promise<{
  score: ReturnType<typeof scoreConcerns>;
  concerns: ReportConcern[];
  questions: ReportQuestion[];
}> {
  const concerns = await reviewConcerns(ctx);
  const open = concerns.filter((c) => c.status === 'open');
  const resolvedThisRound = concerns.filter(
    (c) => c.status === 'resolved' && c.lastSeenRoundId === round.id,
  ).length;
  const score = scoreConcerns(open, round.createdAt, resolvedThisRound);

  const pending = await pendingUserFacingQuestions(ctx);
  const heldIds = new Set(pending.map((q) => q.concernId).filter((id) => id !== null));
  const slugById = new Map(concerns.map((c) => [c.id, c.slug]));

  return {
    score,
    concerns: open.map((c) => ({
      slug: c.slug,
      title: c.title,
      body: c.body,
      level: c.level,
      characteristics: c.characteristics,
      locations: c.locations,
      isPrior: c.firstSeenAt < round.createdAt,
      gateBlocking: c.gateBlocking,
      blocking: isBlocking(c, ctx.review.id),
      held: heldIds.has(c.id),
    })),
    questions: pending.map((q) => ({
      ordinal: q.ordinal,
      text: q.text,
      recommendation: q.recommendation,
      concernSlug: q.concernId ? (slugById.get(q.concernId) ?? null) : null,
    })),
  };
}

export async function runReport(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  if (round.reportCommentId) return;

  const data = await reportData(ctx, round);
  const body = renderReport({
    mode: 'round',
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
  await db.update(schema.rounds).set({ reportCommentId: commentId }).where(eq(schema.rounds.id, round.id));
  await db.insert(schema.githubArtifacts).values({
    reviewId: ctx.review.id,
    kind: 'report_comment',
    githubId: String(commentId),
    sha: round.headSha,
    roundNo: round.roundNo,
  });
  ctx.round = { ...round, reportCommentId: commentId };
  console.log(`report posted (comment ${commentId})`);
}
