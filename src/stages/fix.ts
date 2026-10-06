import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { loadPrompt, runAgent } from '../agents/run-agent.js';
import { fixPlanOutputSchema } from '../agents/schemas.js';
import { commitAuthorEmail, configuredAuthorEmail, localHeadSha, remoteBranchSha } from '../workspace.js';
import { renderPolicies } from './audit.js';
import { reviewConcerns } from './report.js';
import { requireRound, requireWorkspace, type Ctx } from './context.js';

async function renderAnswers(roundId: number): Promise<string> {
  const rows = await db.select().from(schema.questions).where(eq(schema.questions.roundId, roundId));
  const answered = rows.filter((q) => q.answer !== null).sort((a, b) => a.ordinal - b.ordinal);
  if (answered.length === 0) return '(no questions were asked this round)';
  return answered.map((q) => `- Q: ${q.text}\n  A: ${q.answer}`).join('\n');
}

function renderConcernsBlock(
  concerns: Array<{ slug: string; level: string; title: string; body: string; locations: Array<{ file: string; line: number | null }> }>,
): string {
  return concerns
    .map(
      (c) =>
        `### ${c.slug} (${c.level})\n${c.title}\nLocations: ${c.locations
          .map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`)
          .join(', ')}\n\n${c.body}`,
    )
    .join('\n\n');
}

export async function runFixPlanning(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  if (round.plan) return;

  // Every user-facing question is answered before this stage runs (runAwaitAnswers blocks
  // on them), so nothing is held back here. Non-blocking verification-round discoveries stay
  // out of the plan — they are recorded for a future PR, never fixed in this one.
  const open = (await reviewConcerns(ctx)).filter((c) => c.status === 'open' && c.gateBlocking);
  if (open.length === 0) return;

  const res = await runAgent({
    roundId: round.id,
    role: 'fix-planner',
    cwd: requireWorkspace(ctx),
    outputSchema: fixPlanOutputSchema,
    model: 'opus',
    prompt: loadPrompt('fix-planner.md', {
      HEAD_SHA: round.headSha,
      CONCERNS: renderConcernsBlock(open),
      ANSWERS: await renderAnswers(round.id),
      POLICIES: await renderPolicies(ctx.repo.id),
    }),
  });

  const plan = {
    steps: res.output.steps.map((s) => ({
      concernSlug: s.concern_slug,
      approach: s.approach,
      files: s.files,
    })),
    commitMessage: res.output.commit_message,
  };
  await db.update(schema.rounds).set({ plan }).where(eq(schema.rounds.id, round.id));
  ctx.round = { ...round, plan };
  console.log(`fix plan: ${plan.steps.length} step(s)`);
}

export async function runFixing(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  const workspace = requireWorkspace(ctx);
  if (!round.plan) throw new Error('fixing without a stored plan');

  // Two very different things used to look identical here: our own fix already being on the
  // branch (a run died after pushing, so re-entering must not fix twice) and somebody else having
  // pushed while the round waited for answers. Inequality alone cannot tell them apart, and under
  // CI the waiting window is hours, so the second case was common — and it silently skipped the
  // fixer, leaving the judges to grade the owner's unrelated commits and the gate to pass over
  // concerns no one had touched. `fixSha` is the recorded, verified head of our own push.
  const remoteSha = await remoteBranchSha(workspace, ctx.review.prBranch);
  if (round.fixSha && remoteSha === round.fixSha) {
    console.log(`remote is at this round's fix ${remoteSha.slice(0, 10)} — already pushed, skipping fixer`);
    return;
  }
  if (round.fixSha && remoteSha === round.headSha) {
    // We provably pushed (fixSha is set) and the branch is back at the pre-fix head, so our commit
    // was removed. Re-running the fixer here would silently re-apply work somebody deliberately
    // force-pushed away — the one case these guards used to fall straight through.
    throw new Error(
      `our fix ${round.fixSha.slice(0, 10)} is no longer on the branch, which is back at ` +
        `${remoteSha.slice(0, 10)} — it was force-pushed away; not re-applying it. Comment on the PR ` +
        'to review the branch as it now stands',
    );
  }
  if (remoteSha !== round.headSha && !round.fixSha) {
    // fixSha is written immediately after the push, but a run killed in that gap would leave our
    // own fix looking exactly like somebody else's — and the loud failure below would then repeat
    // on every retry, because nothing later can supply the missing fixSha. Authorship settles it,
    // read from the workspace's own git config rather than from the environment: the identity can
    // come from a global config too, and comparing against the variable left this disabled wherever
    // it was not set — and wrong across any change to the default.
    const author = await commitAuthorEmail(workspace, `origin/${ctx.review.prBranch}`);
    const ours = (await configuredAuthorEmail(workspace)) ?? process.env.REVIEWER_GIT_EMAIL;
    if (ours && author === ours) {
      console.log(`remote head ${remoteSha.slice(0, 10)} is authored by ${author} — our push, recording it`);
      await db.update(schema.rounds).set({ fixSha: remoteSha }).where(eq(schema.rounds.id, round.id));
      ctx.round = { ...round, fixSha: remoteSha };
      return;
    }
  }
  if (remoteSha !== round.headSha) {
    // Loudly, and without rebasing: the plan names files and approaches derived from a diff that
    // no longer describes the branch. A fresh round has to re-read the new head.
    throw new Error(
      `branch moved during the fix round — plan is stale (round audited ${round.headSha.slice(0, 10)}, ` +
        `remote is now ${remoteSha.slice(0, 10)}` +
        `${round.fixSha ? `, our own fix was ${round.fixSha.slice(0, 10)}` : ''}) — ` +
        'the plan was never written against this head; comment on the PR to start a fresh round',
    );
  }

  const planBlock = round.plan.steps
    .map((s, i) => `${i + 1}. [${s.concernSlug}] ${s.approach}\n   Files: ${s.files.join(', ')}`)
    .join('\n');

  await runAgent({
    roundId: round.id,
    role: 'fixer',
    cwd: workspace,
    outputSchema: z.object({ commit_message: z.string() }),
    model: 'opus',
    tools: 'write',
    // Never reuse a succeeded fixer session: its product is the pushed commit, not the text it
    // returned, and a session that "succeeded" with a failed push would otherwise be replayed
    // forever while the branch never moves.
    reuseSucceeded: false,
    // And no in-call retry. Every other agent is idempotent — it reads and reports — but a second
    // fixer attempt starts in a tree the first one already edited and committed, against a prompt
    // that still describes the original head, and is told to implement the whole plan again. A fresh
    // run with a clean clone is the only safe retry.
    maxRetries: 0,
    prompt:
      loadPrompt('fixer.md', {
        PR_BRANCH: ctx.review.prBranch,
        HEAD_SHA: round.headSha,
        PLAN: planBlock,
        TEST_COMMANDS: ctx.repo.testCommands.map((t) => `- ${t.command}`).join('\n') || '(none configured)',
        COMMIT_MESSAGE: round.plan.commitMessage,
      }) +
      '\n\nWhen done, return the commit message you used via the structured output.',
  });

  const pushed = await remoteBranchSha(workspace, ctx.review.prBranch);
  if (pushed === round.headSha) {
    throw new Error('fixer finished but the remote branch did not advance — fix was not pushed');
  }
  // "The branch moved" is not the same as "we moved it". If the owner pushed while the fixer was
  // working, the fixer's own push is rejected as non-fast-forward (its prompt forbids force-pushing,
  // so it cannot recover) and it still returns a commit message — leaving the remote at THEIR commit,
  // past our head, which the check above happily accepts. Recording that as fixSha then disarmed the
  // judging guard and let the judges grade the owner's diff as our fix: the exact mis-attribution
  // this column exists to prevent. The fixer's commit is still in the workspace, so compare.
  const localHead = await localHeadSha(workspace);
  if (pushed !== localHead) {
    throw new Error(
      `the branch is at ${pushed.slice(0, 10)}, which is not the commit the fixer produced ` +
        `(${localHead.slice(0, 10)}) — our push did not land, most likely rejected because the branch ` +
        'moved during the fix round; the plan is stale, so comment on the PR to start a fresh round',
    );
  }
  // Recorded from the remote we just re-read, and only once it matches what we built.
  await db.update(schema.rounds).set({ fixSha: pushed }).where(eq(schema.rounds.id, round.id));
  ctx.round = { ...round, fixSha: pushed };
  console.log(`fix pushed: ${pushed.slice(0, 10)}`);
}
