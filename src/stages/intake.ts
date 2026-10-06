import { and, eq, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getPr } from '../github.js';
import { prepareWorkspace, runRepoCommand } from '../workspace.js';
import { MAX_ROUNDS, requireWorkspace, type Ctx } from './context.js';

export interface ReviewSlotConflict {
  reviewId: number;
  pr: number;
  state: string;
  /** Last state change. The only evidence available that a run is still alive. */
  updatedAt: Date;
}

/**
 * States that exist only while a run is actively working. A review sits in `awaiting_answers` for
 * as long as the owner takes to reply — days is normal and correct — so it is deliberately absent:
 * treating it as stale would steal the slot from the one review that is behaving exactly as designed.
 */
export const ACTIVE_WORK_STATES = new Set([
  'intake',
  'auditing',
  'synthesizing',
  'reporting',
  'fix_planning',
  'fixing',
  'judging',
  'gating',
]);

/**
 * How long a holder may sit in an active-work state before it is presumed dead. Above GitHub's 6h
 * hard kill, so a genuinely long run is never robbed of its slot; a run killed by that cap, or
 * cancelled, never gets to record anything, so this is the only thing that frees the repo.
 */
const STALE_HOLDER_MS = 7 * 60 * 60 * 1000;

/** Either this review holds the repo's review slot, or the review that does is named. */
export type SlotClaim =
  | { ok: true }
  | { ok: false; conflict: ReviewSlotConflict; reason: 'open' | 'unknown' };

/**
 * One active review per repo — but a run killed mid-pipeline leaves its review parked in a
 * non-terminal state forever, blocking every later PR. A review whose PR is no longer open
 * can never make progress (its own intake would reject the closed PR), so it is retired
 * rather than left for the owner to reset by hand. Anything still open really is a conflict,
 * and so is a PR whose state cannot be fetched: never steal a slot that cannot be proven free.
 *
 * Pure so the precedence is testable without a database or the GitHub API.
 */
export function classifyConflicts(
  conflicts: ReviewSlotConflict[],
  prStateOf: (pr: number) => string | null,
  now: number = Date.now(),
): {
  retire: Array<ReviewSlotConflict & { why: string }>;
  block: { conflict: ReviewSlotConflict; reason: 'open' | 'unknown' } | null;
} {
  const retire: Array<ReviewSlotConflict & { why: string }> = [];
  for (const conflict of conflicts) {
    // Checked before asking GitHub anything: a holder stuck mid-work is dead whatever its PR says,
    // and this is the only path that frees a slot after a run was killed without recording a thing.
    const idleMs = now - conflict.updatedAt.getTime();
    if (ACTIVE_WORK_STATES.has(conflict.state) && idleMs > STALE_HOLDER_MS) {
      retire.push({
        ...conflict,
        why: `no progress in ${Math.round(idleMs / 3_600_000)}h while in ${conflict.state} — run presumed killed`,
      });
      continue;
    }
    const prState = prStateOf(conflict.pr);
    if (prState === null) return { retire, block: { conflict, reason: 'unknown' } };
    if (prState === 'open') return { retire, block: { conflict, reason: 'open' } };
    retire.push({ ...conflict, why: `PR is ${prState}` });
  }
  return { retire, block: null };
}

/**
 * Take the repo's review slot for this review, retiring dead holders on the way. Called
 * before the review leaves `pending`, because a review that has already advanced out of it
 * would be counted among the conflicts it is being tested against — and because `pending` is
 * where a turned-away review waits: it blocks nobody, and `code-reviewer next` finds it there.
 */
export async function claimReviewSlot(ctx: Ctx): Promise<SlotClaim> {
  return resolveSlot(ctx.repo.id, ctx.repo.slug, ctx.review.id);
}

/**
 * Who holds the repo's review slot, after retiring any holder that is provably dead.
 *
 * Both callers need the retirement, not just the answer: the queue (`code-reviewer next`) used to
 * ask only whether a non-terminal review existed, so a holder whose PR was closed — and `closed`
 * is not one of the workflow's triggers, so nothing re-enters it — blocked every queued PR for
 * good, with the scheduled sweep reporting "still holds the slot" forever.
 */
export async function resolveSlot(
  repoId: number,
  repoSlug: string,
  excludeReviewId: number | null,
): Promise<SlotClaim> {
  const rows = await db
    .select({
      id: schema.reviews.id,
      pr: schema.reviews.prNumber,
      state: schema.reviews.state,
      updatedAt: schema.reviews.updatedAt,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repoId, repoId),
        notInArray(schema.reviews.state, ['passed', 'failed', 'pending']),
      ),
    );
  const conflicts: ReviewSlotConflict[] = rows
    .filter((r) => r.id !== excludeReviewId)
    .map((r) => ({ reviewId: r.id, pr: r.pr, state: r.state, updatedAt: r.updatedAt }));
  if (conflicts.length === 0) return { ok: true };

  const prStates = new Map<number, string | null>();
  for (const conflict of conflicts) {
    try {
      prStates.set(conflict.pr, (await getPr(repoSlug, conflict.pr)).state);
    } catch (err) {
      console.warn(`could not check PR #${conflict.pr} (${String(err).split('\n')[0]})`);
      prStates.set(conflict.pr, null);
    }
  }

  const { retire, block } = classifyConflicts(conflicts, (pr) => prStates.get(pr) ?? null);
  for (const stale of retire) {
    // `failed`, never `pending`: `failed` is what makes the next run consult inferRetryState and
    // resume where this one died. A review downgraded to `pending` restarts at intake and audits an
    // empty diff instead, which is how a stale pass turns into a green gate.
    await db
      .update(schema.reviews)
      .set({
        state: 'failed',
        error: `abandoned in state ${stale.state}: ${stale.why}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.reviews.id, stale.reviewId));
    console.log(`released stale review for PR #${stale.pr} (was ${stale.state}, ${stale.why})`);
  }
  return block ? { ok: false, ...block } : { ok: true };
}

/**
 * Bring the workspace to a state the repo's own commands can run in — `npm ci` and the like.
 *
 * Needed on a resume as well as at intake, and that is not a nicety: a laptop kept one workspace
 * across the whole review, so dependencies installed once lasted all round. Each CI run gets an
 * empty runner, so a resumed run that skipped this handed the fixer a tree with no node_modules and
 * a prompt telling it to run the tests. Setup commands are expected to be idempotent, so running it
 * again costs a minute rather than correctness.
 */
export async function runSetup(ctx: Ctx): Promise<void> {
  if (!ctx.repo.setupCommand) return;
  console.log(`running setup: ${ctx.repo.setupCommand}`);
  const setup = await runRepoCommand(requireWorkspace(ctx), ctx.repo.setupCommand);
  if (!setup.passed) throw new Error(`setup command failed:\n${setup.trimmedOutput}`);
}

export async function runIntake(ctx: Ctx): Promise<void> {
  const pr = await getPr(ctx.repo.slug, ctx.review.prNumber);
  if (pr.isFork) throw new Error('fork PRs are not supported (no push access to the fork branch)');
  if (pr.state !== 'open') throw new Error(`PR #${ctx.review.prNumber} is ${pr.state}, not open`);
  // Checked here rather than in the workflow's `if`, because the issue_comment payload carries no
  // draft flag at all — so a comment on a draft would otherwise take the repo's review slot and
  // spend a full round on work its author has said is not ready.
  if (pr.isDraft) throw new Error(`PR #${ctx.review.prNumber} is a draft — not reviewed until ready`);

  // Reuse the current round only if it's for this same head SHA and hasn't finished intake.
  let round = ctx.round;
  if (!round || round.headSha !== pr.headSha || round.synthesizedAt !== null) {
    const prev = round;
    const prevNo = prev?.roundNo ?? 0;
    if (prevNo + 1 > MAX_ROUNDS) {
      throw new Error(`intake would create round ${prevNo + 1} past the cap of ${MAX_ROUNDS} — state machine bug`);
    }
    // A round following a fix cycle verifies the fix diff instead of re-auditing the whole PR.
    // The PR summary is carried forward so reports keep describing the full PR (the scout
    // only runs in full rounds).
    let kind: 'full' | 'verification' = 'full';
    let baseSha = pr.baseSha;
    let prSummary: string | null = null;
    if (prev?.plan) {
      kind = 'verification';
      baseSha = prev.headSha; // pre-fix SHA: base...head is exactly the fix commits
      prSummary = prev.prSummary;
    } else if (prev?.kind === 'verification') {
      // Head moved before the verification round synthesized — restart it against the same base.
      kind = 'verification';
      baseSha = prev.baseSha;
      prSummary = prev.prSummary;
    }
    [round] = await db
      .insert(schema.rounds)
      .values({
        reviewId: ctx.review.id,
        roundNo: prevNo + 1,
        kind,
        headSha: pr.headSha,
        baseSha,
        prSummary,
      })
      .returning();
    await db
      .update(schema.reviews)
      .set({ currentRoundId: round.id, prBranch: pr.headRef, updatedAt: new Date() })
      .where(eq(schema.reviews.id, ctx.review.id));
    console.log(`round ${round.roundNo} (${kind}) created for ${pr.headSha.slice(0, 10)}`);
  }
  ctx.round = round;

  ctx.workspaceDir = await prepareWorkspace(
    ctx.repo.slug,
    ctx.repo.cloneUrl,
    pr.headRef,
    pr.headSha,
  );
  console.log(`workspace ready at ${ctx.workspaceDir}`);

  if (!round.testResults) {
    await runSetup(ctx);
    const results = [];
    for (const tc of ctx.repo.testCommands) {
      console.log(`running tests: ${tc.name} (${tc.command})`);
      const res = await runRepoCommand(ctx.workspaceDir, tc.command);
      results.push({
        name: tc.name,
        command: tc.command,
        passed: res.passed,
        ranAt: new Date().toISOString(),
        trimmedOutput: res.trimmedOutput,
        timedOut: res.timedOut,
      });
      console.log(`  ${tc.name}: ${res.passed ? 'pass' : res.timedOut ? 'TIMED OUT' : 'FAIL'}`);
    }
    await db.update(schema.rounds).set({ testResults: results }).where(eq(schema.rounds.id, round.id));
    ctx.round = { ...round, testResults: results };
  }
}
