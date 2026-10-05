import { and, eq, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getPr } from '../github.js';
import { prepareWorkspace, runRepoCommand } from '../workspace.js';
import { MAX_ROUNDS, type Ctx } from './context.js';

export interface ReviewSlotConflict {
  reviewId: number;
  pr: number;
  state: string;
}

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
): {
  retire: Array<ReviewSlotConflict & { prState: string }>;
  block: { conflict: ReviewSlotConflict; reason: 'open' | 'unknown' } | null;
} {
  const retire: Array<ReviewSlotConflict & { prState: string }> = [];
  for (const conflict of conflicts) {
    const prState = prStateOf(conflict.pr);
    if (prState === null) return { retire, block: { conflict, reason: 'unknown' } };
    if (prState === 'open') return { retire, block: { conflict, reason: 'open' } };
    retire.push({ ...conflict, prState });
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
    .select({ id: schema.reviews.id, pr: schema.reviews.prNumber, state: schema.reviews.state })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repoId, repoId),
        notInArray(schema.reviews.state, ['passed', 'failed', 'pending']),
      ),
    );
  const conflicts: ReviewSlotConflict[] = rows
    .filter((r) => r.id !== excludeReviewId)
    .map((r) => ({ reviewId: r.id, pr: r.pr, state: r.state }));
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
    await db
      .update(schema.reviews)
      .set({
        state: 'failed',
        error: `abandoned in state ${stale.state}: PR #${stale.pr} is ${stale.prState}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.reviews.id, stale.reviewId));
    console.log(`released stale review for PR #${stale.pr} (was ${stale.state}, PR is ${stale.prState})`);
  }
  return block ? { ok: false, ...block } : { ok: true };
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
    if (ctx.repo.setupCommand) {
      console.log(`running setup: ${ctx.repo.setupCommand}`);
      const setup = await runRepoCommand(ctx.workspaceDir, ctx.repo.setupCommand);
      if (!setup.passed) {
        throw new Error(`setup command failed:\n${setup.trimmedOutput}`);
      }
    }
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
      });
      console.log(`  ${tc.name}: ${res.passed ? 'pass' : 'FAIL'}`);
    }
    await db.update(schema.rounds).set({ testResults: results }).where(eq(schema.rounds.id, round.id));
    ctx.round = { ...round, testResults: results };
  }
}
