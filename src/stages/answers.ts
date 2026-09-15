import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getCommentCreatedAt, listRepliesSince } from '../github.js';
import { loadPrompt, runAgent } from '../agents/run-agent.js';
import { answersOutputSchema } from '../agents/schemas.js';
import { parseAnswers } from '../parse-answers.js';
import { blockingConcerns } from './report.js';
import { pendingUserFacingQuestions, type QuestionRow } from './questions.js';
import { requireRound, requireWorkspace, type Ctx } from './context.js';

const POLL_INTERVAL_MS = 30_000;

/** Comment ids this reviewer posted itself — never parse our own reports as answers. */
async function ownCommentIds(ctx: Ctx): Promise<Set<number>> {
  const rows = await db
    .select({ githubId: schema.githubArtifacts.githubId, kind: schema.githubArtifacts.kind })
    .from(schema.githubArtifacts)
    .where(eq(schema.githubArtifacts.reviewId, ctx.review.id));
  return new Set(
    rows
      .filter((r) => r.kind === 'report_comment' || r.kind === 'summary_comment' || r.kind === 'pr_summary_comment')
      .map((r) => Number(r.githubId))
      .filter((n) => Number.isFinite(n)),
  );
}

async function recordAnswer(ctx: Ctx, q: QuestionRow, answer: string, commentId: number): Promise<void> {
  await db
    .update(schema.questions)
    .set({ answer, answeredAt: new Date(), sourceCommentId: commentId })
    .where(eq(schema.questions.id, q.id));
  await db.insert(schema.policies).values({
    repoId: ctx.repo.id,
    question: q.text,
    answer,
    sourceReviewId: ctx.review.id,
  });
}

/**
 * One pass over PR replies since the oldest pending question's report: record any answers
 * found (partial replies count — each answered ordinal unblocks its concern independently).
 * Returns how many questions were answered.
 */
async function pollAnswersOnce(ctx: Ctx, pending: QuestionRow[]): Promise<number> {
  if (pending.length === 0) return 0;
  const roundIds = [...new Set(pending.map((q) => q.roundId))];
  const rounds = await db.select().from(schema.rounds).where(inArray(schema.rounds.id, roundIds));
  const reported = rounds
    .filter((r) => r.reportCommentId !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (reported.length === 0) return 0; // questions exist but were never surfaced to the owner yet

  const earliest = reported[0];
  const reportedAt = await getCommentCreatedAt(ctx.repo.slug, earliest.reportCommentId!);
  const own = await ownCommentIds(ctx);
  const comments = await listRepliesSince(
    ctx.repo.slug,
    ctx.review.prNumber,
    reportedAt,
    earliest.reportCommentId!,
  );

  const open = new Map(pending.map((q) => [q.ordinal, q]));
  let answered = 0;
  for (const comment of comments) {
    if (own.has(comment.id)) continue;
    if (open.size === 0) break;
    const expected = [...open.keys()];
    const remaining = [...open.values()];

    let answers = parseAnswers(comment.body, expected)?.answers ?? null;
    if (!answers && /\bgo with (your|the) recommendations?\b/i.test(comment.body)) {
      answers = new Map(
        remaining
          .filter((q) => q.recommendation)
          .map((q) => [q.ordinal, `(accepted recommendation) ${q.recommendation}`]),
      );
      if (answers.size === 0) answers = null;
    }
    if (!answers) {
      // Free-text reply: map it to ordinals with a small model.
      try {
        const res = await runAgent({
          roundId: requireRound(ctx).id,
          role: `answer-mapper:${comment.id}`,
          cwd: requireWorkspace(ctx),
          outputSchema: answersOutputSchema,
          model: 'haiku',
          readOnly: true,
          maxRetries: 0,
          prompt: loadPrompt('answer-mapper.md', {
            QUESTIONS: remaining
              .map(
                (q) =>
                  `${q.ordinal}. ${q.text}${q.recommendation ? `\n   (recommended: ${q.recommendation})` : ''}`,
              )
              .join('\n'),
            REPLY: comment.body,
          }),
        });
        answers = new Map(
          res.output.answers
            .filter((a) => open.has(a.ordinal) && a.answer.trim() !== '')
            .map((a) => [a.ordinal, a.answer]),
        );
        if (answers.size === 0) answers = null;
      } catch (err) {
        console.warn(`could not map reply ${comment.id} to answers: ${String(err)}`);
      }
    }
    if (!answers) continue;

    for (const [ordinal, answer] of answers) {
      const q = open.get(ordinal);
      if (!q) continue;
      await recordAnswer(ctx, q, answer, comment.id);
      open.delete(ordinal);
      answered++;
    }
    console.log(`reply ${comment.id} from ${comment.authorLogin} answered ${answers.size} question(s)`);
  }
  return answered;
}

/**
 * Check for owner replies to user-facing questions (across all rounds of this review).
 * Never blocks while at least one blocking concern is actionable — fixes for everything
 * else proceed and held concerns wait for their answers in a later round. Only when EVERY
 * blocking concern is held behind an unanswered question does this poll until one arrives.
 */
export async function runAwaitAnswers(ctx: Ctx): Promise<void> {
  let pending = await pendingUserFacingQuestions(ctx);
  if (pending.length === 0) return;

  try {
    await pollAnswersOnce(ctx, pending);
  } catch (err) {
    console.warn(`comment check failed (${String(err).split('\n')[0]}) — continuing`);
  }
  pending = await pendingUserFacingQuestions(ctx);
  if (pending.length === 0) return;

  const held = new Set(pending.map((q) => q.concernId).filter((id) => id !== null));
  const blocking = await blockingConcerns(ctx);
  const actionable = blocking.filter((c) => !held.has(c.id));
  if (blocking.length === 0 || actionable.length > 0) {
    console.log(
      `${pending.length} user-facing question(s) still pending — proceeding with fixes for the other concerns`,
    );
    return;
  }

  console.log(
    `all ${blocking.length} blocking concern(s) are waiting on your answers on PR #${ctx.review.prNumber} — polling…`,
  );
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      await pollAnswersOnce(ctx, await pendingUserFacingQuestions(ctx));
      // Return only once an answer actually frees a blocking concern for fixing —
      // fix planning must never run with nothing actionable.
      const pendingNow = await pendingUserFacingQuestions(ctx);
      const heldNow = new Set(pendingNow.map((q) => q.concernId).filter((id) => id !== null));
      const blockingNow = await blockingConcerns(ctx);
      if (blockingNow.length === 0 || blockingNow.some((c) => !heldNow.has(c.id))) return;
    } catch (err) {
      // Transient network/API failures must not kill a multi-hour wait — log and keep polling.
      console.warn(`comment poll failed (${String(err).split('\n')[0]}) — retrying in ${POLL_INTERVAL_MS / 1000}s`);
    }
  }
}
