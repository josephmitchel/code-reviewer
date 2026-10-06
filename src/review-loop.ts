import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/client.js';
import { getPr } from './github.js';
import { prepareWorkspace, workspacePath } from './workspace.js';
import { claimReviewSlot, runIntake, runSetup } from './stages/intake.js';
import { runAudit } from './stages/audit.js';
import { runSynthesis } from './stages/synthesis.js';
import { runReport, blockingConcerns } from './stages/report.js';
import { runAwaitAnswers } from './stages/answers.js';
import { pendingUserFacingQuestions } from './stages/questions.js';
import { runFixPlanning, runFixing } from './stages/fix.js';
import { runJudging } from './stages/judge.js';
import { runGating } from './stages/gate.js';
import { MAX_ROUNDS, requireRound, type Ctx } from './stages/context.js';

type State = (typeof schema.reviewState.enumValues)[number];

async function setState(ctx: Ctx, state: State, error: string | null = null): Promise<void> {
  await db
    .update(schema.reviews)
    .set({ state, error, updatedAt: new Date() })
    .where(eq(schema.reviews.id, ctx.review.id));
  ctx.review = { ...ctx.review, state, error };
  console.log(`\n=== state: ${state} ===`);
}

async function loadCtx(repoSlug: string, prNumber: number): Promise<Ctx> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, repoSlug));
  if (!repo) throw new Error(`repo ${repoSlug} not registered — run: code-reviewer repo add ${repoSlug} …`);

  let [review] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.prNumber, prNumber)));
  if (!review) {
    const pr = await getPr(repoSlug, prNumber);
    [review] = await db
      .insert(schema.reviews)
      .values({ repoId: repo.id, prNumber, prBranch: pr.headRef, state: 'pending' })
      .returning();
    console.log(`review created for ${repoSlug}#${prNumber} (${pr.headRef})`);
  } else {
    console.log(`resuming review ${review.id} for ${repoSlug}#${prNumber} in state ${review.state}`);
  }

  const round = review.currentRoundId
    ? (await db.select().from(schema.rounds).where(eq(schema.rounds.id, review.currentRoundId)))[0] ?? null
    : null;

  return { repo, review, round, workspaceDir: null };
}

/** Where a run left the review: finished, waiting on the owner, or waiting for the slot. */
export type ReviewOutcome = 'passed' | 'awaiting_answers' | 'queued';

export interface RunReviewOptions {
  /**
   * Return at the first point the review cannot advance on its own instead of waiting it out.
   * A CI run is billed for every minute it holds a runner, so a review that needs an answer
   * (or the repo's review slot) exits and is re-entered by the next GitHub event — the state
   * in Postgres is the entire handoff. Local runs leave this off and wait.
   */
  oneShot?: boolean;
}

export async function runReview(
  repoSlug: string,
  prNumber: number,
  options: RunReviewOptions = {},
): Promise<ReviewOutcome> {
  const oneShot = options.oneShot ?? false;
  const ctx = await loadCtx(repoSlug, prNumber);

  // Claim the repo's review slot before this review leaves `pending`: a review that has
  // already advanced past it counts among the conflicts it would be tested against, and
  // `pending` is where a turned-away review waits without blocking anyone.
  if (ctx.review.state === 'pending' || ctx.review.state === 'failed') {
    const claim = await claimReviewSlot(ctx);
    if (!claim.ok) {
      console.log(
        `review for PR #${claim.conflict.pr} holds the slot (state ${claim.conflict.state})` +
          (claim.reason === 'unknown' ? ' and its PR state could not be checked' : '') +
          ` — PR #${prNumber} stays queued`,
      );
      // Deliberately leave a turned-away `failed` review in `failed`. Moving it to `pending` to
      // get it back in the queue looked kind and was catastrophic: `failed` is the ONLY marker
      // that makes the next run consult `inferRetryState`, so a review downgraded to `pending`
      // restarts at intake, opens a fresh verification round against its own unchanged head,
      // audits an empty diff, burns the round cap and gates GREEN over concerns nobody fixed.
      // A failed review waits for a comment on its PR instead, which re-enters it by number.
      return 'queued';
    }
  }

  if (ctx.review.state === 'failed') {
    console.log(`previous run failed (${ctx.review.error ?? 'no error recorded'}) — retrying`);
    await setState(ctx, await inferRetryState(ctx));
  }

  while (ctx.review.state !== 'passed') {
    try {
      // Inside the try: rebuilding the workspace is where a resume most often dies — a force-push
      // or squash can leave the round's head SHA unreachable — and outside it that threw without
      // ever recording `failed`, leaving the review holding the repo's slot in a live-looking state.
      if (!ctx.workspaceDir && ctx.review.state !== 'pending' && ctx.review.state !== 'intake') {
        await runIntakeWorkspaceOnly(ctx);
      }
      switch (ctx.review.state) {
        case 'pending':
          await setState(ctx, 'intake');
          break;
        case 'intake':
          await runIntake(ctx);
          await setState(ctx, 'auditing');
          break;
        case 'auditing':
          await runAudit(ctx);
          await setState(ctx, 'synthesizing');
          break;
        case 'synthesizing': {
          await runSynthesis(ctx);
          const blocking = await blockingConcerns(ctx);
          const atCap = requireRound(ctx).roundNo >= MAX_ROUNDS;
          if (blocking.length > 0 && atCap) {
            console.log(
              `round cap (${MAX_ROUNDS}) reached with ${blocking.length} open blocking concern(s) — passing with warnings`,
            );
          }
          await setState(ctx, blocking.length === 0 || atCap ? 'gating' : 'reporting');
          break;
        }
        case 'reporting':
          await runReport(ctx);
          // With nothing to ask the owner there is nothing to await — skip straight to fixes
          // rather than announcing a wait that resolves immediately.
          await setState(ctx, await stateAfterReport(ctx));
          break;
        case 'awaiting_answers': {
          const answered = await runAwaitAnswers(ctx, { poll: !oneShot });
          if (!answered) return 'awaiting_answers';
          await setState(ctx, 'fix_planning');
          break;
        }
        case 'fix_planning':
          await runFixPlanning(ctx);
          await setState(ctx, 'fixing');
          break;
        case 'fixing':
          await runFixing(ctx);
          await setState(ctx, 'judging');
          break;
        case 'judging':
          await runJudging(ctx);
          await setState(ctx, 'intake'); // fresh audit round on the post-fix head
          break;
        case 'gating':
          await runGating(ctx);
          await setState(ctx, 'passed');
          break;
        default:
          throw new Error(`unhandled state ${ctx.review.state}`);
      }
    } catch (err) {
      await setState(ctx, 'failed', String(err));
      throw err;
    }
  }
  console.log(`\nreview passed — PR #${prNumber} gate is green.`);
  return 'passed';
}

/** Only wait on the owner when there is actually an unanswered user-facing question. */
async function stateAfterReport(ctx: Ctx): Promise<State> {
  const pending = await pendingUserFacingQuestions(ctx);
  return pending.length > 0 ? 'awaiting_answers' : 'fix_planning';
}

/**
 * For resumes that land mid-pipeline: rebuild the workspace without creating a new round.
 *
 * Every CI run starts on a bare runner, so this is a full clone AND the repo's setup command —
 * the fixer and the judges both run the repo's tests, and a tree with no dependencies fails them
 * for reasons that have nothing to do with the code under review.
 */
async function runIntakeWorkspaceOnly(ctx: Ctx): Promise<void> {
  if (!ctx.round) throw new Error(`state ${ctx.review.state} with no current round`);
  ctx.workspaceDir = await prepareWorkspace(
    ctx.repo.slug,
    ctx.repo.cloneUrl,
    ctx.review.prBranch,
    ctx.round.headSha,
  );
  await runSetup(ctx);
}

/** A failed run retries the state it failed in (recorded state was already advanced past pending). */
async function inferRetryState(ctx: Ctx): Promise<State> {
  // reviews.state was overwritten with 'failed'; the last real state is recoverable from progress markers.
  if (!ctx.round) return 'intake';
  if (!ctx.round.testResults) return 'intake';
  if (!ctx.round.synthesizedAt) return 'auditing';
  if (!ctx.round.reportCommentId) return 'synthesizing';
  if (!ctx.round.plan) return stateAfterReport(ctx);
  return 'fixing';
}

export { workspacePath };
