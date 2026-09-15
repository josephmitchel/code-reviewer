import { and, eq, ne, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getPr } from '../github.js';
import { prepareWorkspace, runRepoCommand } from '../workspace.js';
import { MAX_ROUNDS, type Ctx } from './context.js';

export async function runIntake(ctx: Ctx): Promise<void> {
  const conflicting = await db
    .select({ id: schema.reviews.id, pr: schema.reviews.prNumber })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repoId, ctx.repo.id),
        ne(schema.reviews.id, ctx.review.id),
        notInArray(schema.reviews.state, ['passed', 'failed', 'pending']),
      ),
    );
  if (conflicting.length > 0) {
    throw new Error(
      `another review is active for ${ctx.repo.slug} (PR #${conflicting[0].pr}) — one active review per repo`,
    );
  }

  const pr = await getPr(ctx.repo.slug, ctx.review.prNumber);
  if (pr.isFork) throw new Error('fork PRs are not supported (no push access to the fork branch)');
  if (pr.state !== 'open') throw new Error(`PR #${ctx.review.prNumber} is ${pr.state}, not open`);

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
