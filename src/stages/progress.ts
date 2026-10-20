import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { postComment, postStatus, updateComment } from '../github.js';
import { renderProgress, type ProgressPayload } from '../render-report.js';
import type { ReviewRow, RoundRow } from './context.js';

type State = (typeof schema.reviewState.enumValues)[number];
type ReviewRef = Pick<ReviewRow, 'id' | 'prNumber'>;

/**
 * Between a round's report and the next one the reviewer can work for an hour with nothing on the
 * PR, and that looked exactly like a review that had stopped. A fix cycle therefore gets one
 * progress comment, posted when it starts and edited as it moves. Edits are deliberate: the
 * workflow only triggers on created comments, and every bot comment it does see is a skipped run
 * that can cancel a real one waiting in the concurrency group.
 *
 * All of it is best-effort: a progress update that fails must never fail the review.
 */
async function openProgress(reviewId: number) {
  const [row] = await db
    .select()
    .from(schema.githubArtifacts)
    .where(and(eq(schema.githubArtifacts.reviewId, reviewId), eq(schema.githubArtifacts.kind, 'progress_comment')))
    .orderBy(desc(schema.githubArtifacts.id))
    .limit(1);
  const payload = row?.payload as ProgressPayload | undefined;
  return row?.githubId && payload && !payload.finished ? { row, payload } : null;
}

/** Open a fix cycle's progress comment. A cycle already open (a resumed run) just gains the step. */
export async function startProgress(
  slug: string,
  review: ReviewRef,
  round: RoundRow | null,
  intro: string,
  step: string,
): Promise<void> {
  try {
    if (await openProgress(review.id)) return progressStep(slug, review, step);
    const payload: ProgressPayload = { intro, steps: [{ at: new Date().toISOString(), text: step }], finished: false };
    const commentId = await postComment(slug, review.prNumber, renderProgress(payload));
    await db.insert(schema.githubArtifacts).values({
      reviewId: review.id,
      kind: 'progress_comment',
      githubId: String(commentId),
      sha: round?.headSha ?? null,
      roundNo: round?.roundNo ?? null,
      payload,
    });
  } catch (err) {
    console.warn(`could not post the progress comment (${String(err).split('\n')[0]})`);
  }
}

/** Add a step to the open progress comment, if there is one. `finished` closes the cycle. */
export async function progressStep(
  slug: string,
  review: ReviewRef,
  text: string,
  options: { icon?: string; finished?: boolean } = {},
): Promise<void> {
  try {
    const open = await openProgress(review.id);
    if (!open) return;
    const payload: ProgressPayload = {
      ...open.payload,
      steps: [...open.payload.steps, { at: new Date().toISOString(), text, icon: options.icon }],
      finished: options.finished ?? false,
    };
    await updateComment(slug, Number(open.row.githubId), renderProgress(payload));
    await db.update(schema.githubArtifacts).set({ payload }).where(eq(schema.githubArtifacts.id, open.row.id));
  } catch (err) {
    console.warn(`could not update the progress comment (${String(err).split('\n')[0]})`);
  }
}

const GATE_TEXT: Partial<Record<State, string>> = {
  intake: 'setting up',
  auditing: 'auditing',
  synthesizing: 'weighing the findings',
  awaiting_answers: 'waiting for your answers',
  fix_planning: 'planning fixes',
  fixing: 'making fixes',
  judging: 'checking the fixes',
  failed: 'stopped, see the PR comment',
};

/**
 * Keep `code-reviewer/gate` saying where the review is, on the PR's current head: the fix commit
 * once one is pushed, otherwise the head being reviewed. Only gating ever posts success.
 */
export async function markGate(slug: string, round: RoundRow | null, state: State): Promise<void> {
  const text = GATE_TEXT[state];
  if (!text || !round) return;
  // Entering intake from a finished round sets up the next one; runIntake makes the same call.
  const roundNo = state === 'intake' && round.synthesizedAt ? round.roundNo + 1 : round.roundNo;
  try {
    await postStatus(
      slug,
      round.fixSha ?? round.headSha,
      state === 'failed' ? 'failure' : 'pending',
      `Round ${roundNo}: ${text}`,
    );
  } catch (err) {
    console.warn(`could not update the gate status (${String(err).split('\n')[0]})`);
  }
}
