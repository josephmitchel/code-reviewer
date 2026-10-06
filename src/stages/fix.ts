import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { loadPrompt, runAgent } from '../agents/run-agent.js';
import { fixPlanOutputSchema } from '../agents/schemas.js';
import { commitAuthorEmail, remoteBranchSha } from '../workspace.js';
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
  if (remoteSha !== round.headSha && !round.fixSha) {
    // fixSha is written immediately after the push, but a run killed in that gap would leave our
    // own fix looking exactly like somebody else's — and the loud failure below would then repeat
    // on every retry, because nothing later can supply the missing fixSha. Authorship settles it.
    const author = await commitAuthorEmail(workspace, `origin/${ctx.review.prBranch}`);
    const ours = process.env.REVIEWER_GIT_EMAIL;
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
  // Recorded from the remote we just re-read, not from what the agent said it did.
  await db.update(schema.rounds).set({ fixSha: pushed }).where(eq(schema.rounds.id, round.id));
  ctx.round = { ...round, fixSha: pushed };
  console.log(`fix pushed: ${pushed.slice(0, 10)}`);
}
