import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getCommentCreatedAt, listRepliesSince } from '../github.js';
import { loadPrompt, runAgent } from '../agents/run-agent.js';
import { answersOutputSchema } from '../agents/schemas.js';
import { parseAnswers } from '../parse-answers.js';
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
 * found (a partial reply still counts — each answered ordinal is banked as it arrives, the
 * round just keeps waiting for the rest). Returns how many questions were answered.
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

export interface AwaitAnswersOptions {
  /**
   * Keep polling the PR until the last answer lands (a local run, where waiting is free).
   * False checks once and reports back, for a CI run that is billed by the minute and whose
   * next GitHub event will re-enter this stage anyway.
   */
  poll: boolean;
}

/**
 * Collect answers to EVERY user-facing question of this review (any round), and report
 * whether they are all in. Fixing while a question was still open let the fixer commit
 * decisions the owner then contradicted, so nothing advances on partial answers. Whether a
 * question is attached to a concern makes no difference — an unattached question (an
 * outside-world fact we cannot establish) holds the round too.
 *
 * Returns true when no user-facing question is left unanswered, i.e. when fixing may begin.
 */
export async function runAwaitAnswers(
  ctx: Ctx,
  options: AwaitAnswersOptions = { poll: true },
): Promise<boolean> {
  let pending = await pendingUserFacingQuestions(ctx);
  if (pending.length === 0) return true;

  let announced = -1;
  for (;;) {
    try {
      await pollAnswersOnce(ctx, pending);
      pending = await pendingUserFacingQuestions(ctx);
      if (pending.length === 0) {
        console.log('all user-facing questions answered — proceeding to fixes');
        return true;
      }
      if (pending.length !== announced) {
        console.log(
          `${pending.length} user-facing question(s) awaiting your answer on PR #${ctx.review.prNumber} — ` +
            `fixes are paused until every one is answered` +
            (options.poll ? `; polling every ${POLL_INTERVAL_MS / 1000}s…` : ''),
        );
        announced = pending.length;
      }
    } catch (err) {
      // A failed check is not an answer: in CI it means this run learned nothing and the next
      // event will try again, and locally that a multi-hour wait must survive a network blip.
      console.warn(
        `comment poll failed (${String(err).split('\n')[0]})` +
          (options.poll ? ` — retrying in ${POLL_INTERVAL_MS / 1000}s` : ''),
      );
    }
    if (!options.poll) return false;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
