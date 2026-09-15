import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/client.js';
import { getPr } from './github.js';
import { prepareWorkspace, workspacePath } from './workspace.js';
import { runIntake } from './stages/intake.js';
import { runAudit } from './stages/audit.js';
import { runSynthesis } from './stages/synthesis.js';
import { runReport, blockingConcerns } from './stages/report.js';
import { runAwaitAnswers } from './stages/answers.js';
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

export async function runReview(repoSlug: string, prNumber: number): Promise<void> {
  const ctx = await loadCtx(repoSlug, prNumber);
  if (ctx.review.state === 'failed') {
    console.log(`previous run failed (${ctx.review.error ?? 'no error recorded'}) — retrying`);
    await setState(ctx, inferRetryState(ctx));
  }

  while (ctx.review.state !== 'passed') {
    // Any state after intake needs the workspace on disk.
    if (!ctx.workspaceDir && ctx.review.state !== 'pending' && ctx.review.state !== 'intake') {
      await runIntakeWorkspaceOnly(ctx);
    }
    try {
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
          await setState(ctx, 'awaiting_answers');
          break;
        case 'awaiting_answers':
          await runAwaitAnswers(ctx);
          await setState(ctx, 'fix_planning');
          break;
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
}

/** For resumes that land mid-pipeline: ensure the workspace exists without creating a new round. */
async function runIntakeWorkspaceOnly(ctx: Ctx): Promise<void> {
  if (!ctx.round) throw new Error(`state ${ctx.review.state} with no current round`);
  ctx.workspaceDir = await prepareWorkspace(
    ctx.repo.slug,
    ctx.repo.cloneUrl,
    ctx.review.prBranch,
    ctx.round.headSha,
  );
}

/** A failed run retries the state it failed in (recorded state was already advanced past pending). */
function inferRetryState(ctx: Ctx): State {
  // reviews.state was overwritten with 'failed'; the last real state is recoverable from progress markers.
  if (!ctx.round) return 'intake';
  if (!ctx.round.testResults) return 'intake';
  if (!ctx.round.synthesizedAt) return 'auditing';
  if (!ctx.round.reportCommentId) return 'synthesizing';
  if (!ctx.round.plan) return 'awaiting_answers';
  return 'fixing';
}

export { workspacePath };
