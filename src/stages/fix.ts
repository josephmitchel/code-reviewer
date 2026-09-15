import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { loadPrompt, runAgent } from '../agents/run-agent.js';
import { fixPlanOutputSchema } from '../agents/schemas.js';
import { remoteBranchSha } from '../workspace.js';
import { renderPolicies } from './audit.js';
import { reviewConcerns } from './report.js';
import { heldConcernIds } from './questions.js';
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

  // Skip concerns held behind an unanswered user-facing question (they get fixed in a later
  // round once answered) and non-blocking verification-round discoveries (recorded for a
  // future PR, never fixed in this one).
  const held = await heldConcernIds(ctx);
  const open = (await reviewConcerns(ctx)).filter(
    (c) => c.status === 'open' && !held.has(c.id) && c.gateBlocking,
  );
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

  // If the remote branch has already moved past this round's head, the fix was pushed.
  const remoteSha = await remoteBranchSha(workspace, ctx.review.prBranch);
  if (remoteSha !== round.headSha) {
    console.log(`remote already at ${remoteSha.slice(0, 10)} — fix push detected, skipping fixer`);
    return;
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
    readOnly: false,
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
  console.log(`fix pushed: ${pushed.slice(0, 10)}`);
}
