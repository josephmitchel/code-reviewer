import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { loadPrompt, runAgent, withConcurrency } from '../agents/run-agent.js';
import { judgeOutputSchema } from '../agents/schemas.js';
import { prepareWorkspace, remoteBranchSha } from '../workspace.js';
import { reviewConcerns } from './report.js';
import { AGENT_CONCURRENCY, requireRound, requireWorkspace, type Ctx } from './context.js';

export async function runJudging(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  const workspace = requireWorkspace(ctx);
  if (!round.plan) throw new Error('judging without a stored plan');
  const plan = round.plan;

  const postFixSha = await remoteBranchSha(workspace, ctx.review.prBranch);
  if (postFixSha === round.headSha) throw new Error('judging but no fix commits on the remote branch');
  await prepareWorkspace(ctx.repo.slug, ctx.repo.cloneUrl, ctx.review.prBranch, postFixSha);

  const addressedSlugs = new Set(plan.steps.map((s) => s.concernSlug));
  const candidates = (await reviewConcerns(ctx)).filter(
    (c) => c.status === 'open' && addressedSlugs.has(c.slug),
  );

  const jobs = candidates.map((concern) => async () => {
    const step = plan.steps.find((s) => s.concernSlug === concern.slug);
    const res = await runAgent({
      roundId: round.id,
      role: `judge:${concern.slug}`,
      cwd: workspace,
      outputSchema: judgeOutputSchema,
      prompt: loadPrompt('judge.md', {
        HEAD_SHA: postFixSha,
        PRE_FIX_SHA: round.headSha,
        CONCERN: `### ${concern.slug} (${concern.level})\n${concern.title}\nLocations: ${concern.locations
          .map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`)
          .join(', ')}\n\n${concern.body}`,
        PLAN_STEP: step ? step.approach : '(no plan step recorded)',
      }),
    });
    if (res.output.verdict === 'resolved') {
      await db
        .update(schema.concerns)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNote: `Judged resolved at ${postFixSha.slice(0, 10)}: ${res.output.evidence}`,
          lastSeenRoundId: round.id,
        })
        .where(eq(schema.concerns.id, concern.id));
    }
    console.log(`  [judge:${concern.slug}] ${res.output.verdict}`);
  });

  await withConcurrency(jobs, AGENT_CONCURRENCY);
}
