import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getPr } from '../github.js';
import { loadPrompt, runAgent, withConcurrency } from '../agents/run-agent.js';
import { changedFilePaths } from '../workspace.js';
import { auditorOutputSchema, scoutOutputSchema } from '../agents/schemas.js';
import type { TestResult } from '../db/schema.js';
import { ensurePrSummaryComment } from './pr-summary.js';
import { AGENT_CONCURRENCY, AUDITOR_CHARACTERISTICS, requireRound, requireWorkspace, type Ctx } from './context.js';

export function renderTestResults(results: TestResult[] | null): string {
  if (!results || results.length === 0) return 'No test suites are configured for this repo.';
  return results
    .map((r) =>
      r.passed
        ? `- ${r.name} (\`${r.command}\`): PASS`
        : `- ${r.name} (\`${r.command}\`): FAIL\n\`\`\`\n${r.trimmedOutput ?? ''}\n\`\`\``,
    )
    .join('\n');
}

export async function renderPolicies(repoId: number): Promise<string> {
  const rows = await db.select().from(schema.policies).where(eq(schema.policies.repoId, repoId));
  if (rows.length === 0) return '(none yet)';
  return rows.map((p) => `- Q: ${p.question}\n  A: ${p.answer}`).join('\n');
}

export async function runAudit(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  const workspace = requireWorkspace(ctx);

  let blastRadius = round.blastRadius;
  if (!blastRadius) {
    if (round.kind === 'verification') {
      // Verification rounds audit only the fix diff — no scout, no consumer tracing.
      const files = await changedFilePaths(workspace, round.baseSha, round.headSha);
      blastRadius = files.map((path) => ({ path, reason: 'changed by fix commits' }));
      await db.update(schema.rounds).set({ blastRadius }).where(eq(schema.rounds.id, round.id));
      ctx.round = { ...round, blastRadius };
    } else {
      const pr = await getPr(ctx.repo.slug, ctx.review.prNumber);
      const scout = await runAgent({
        roundId: round.id,
        role: 'scout',
        cwd: workspace,
        outputSchema: scoutOutputSchema,
        prompt: loadPrompt('scout.md', {
          HEAD_SHA: round.headSha,
          BASE_SHA: round.baseSha,
          CHANGED_FILES: pr.changedFiles.map((f) => `- ${f}`).join('\n'),
        }),
      });
      blastRadius = scout.output.files;
      await db
        .update(schema.rounds)
        .set({ blastRadius, prSummary: scout.output.pr_summary })
        .where(eq(schema.rounds.id, round.id));
      ctx.round = { ...round, blastRadius, prSummary: scout.output.pr_summary };
    }
  }
  console.log(`blast radius (${round.kind}): ${blastRadius.length} files`);

  if (round.kind !== 'verification') {
    await ensurePrSummaryComment(ctx);
  }

  const blastPaths = new Set(blastRadius.map((f) => f.path));
  const openConcerns = await db
    .select()
    .from(schema.concerns)
    .where(and(eq(schema.concerns.repoId, ctx.repo.id), eq(schema.concerns.status, 'open')));
  const relevantConcerns = openConcerns.filter((c) =>
    c.locations.some((l) => blastPaths.has(l.file)),
  );

  const policies = await renderPolicies(ctx.repo.id);
  const testResults = renderTestResults(round.testResults);
  const blastList = blastRadius.map((f) => `- ${f.path} (${f.reason})`).join('\n');

  // A verification round's scope is one fix commit's diff — redundant passes add cost, not recall.
  const redundancy = round.kind === 'verification' ? 1 : Math.max(1, ctx.repo.redundancy);
  const preamble =
    round.kind === 'verification' ? 'shared/auditor-preamble-verification.md' : 'shared/auditor-preamble.md';
  const jobs: Array<() => Promise<void>> = [];
  for (const characteristic of AUDITOR_CHARACTERISTICS) {
    const priors = relevantConcerns.filter((c) => c.characteristics.includes(characteristic));
    const priorsBlock =
      priors.length === 0
        ? '(none)'
        : priors
            .map(
              (c) =>
                `#### ${c.slug} (${c.level})\n${c.title}\nLocations: ${c.locations
                  .map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`)
                  .join(', ')}\n\n${c.body}`,
            )
            .join('\n\n');

    let definition = loadPrompt(`auditors/${characteristic}.md`, {
      HARNESS_NOTES: ctx.repo.harnessNotes ?? '(no harness notes provided)',
    });
    const prompt =
      loadPrompt(preamble, {
        CHARACTERISTIC: characteristic,
        BASE_SHA: round.baseSha,
        HEAD_SHA: round.headSha,
        BLAST_RADIUS: blastList,
        POLICIES: policies,
        TEST_RESULTS: testResults,
        DEFINITION: definition,
      }) + `\n\n## Prior open concerns\n\n${priorsBlock}\n`;

    for (let i = 1; i <= redundancy; i++) {
      const role = redundancy === 1 ? `auditor-${characteristic}` : `auditor-${characteristic}-${i}`;
      jobs.push(async () => {
        const res = await runAgent({
          roundId: round.id,
          role,
          cwd: workspace,
          outputSchema: auditorOutputSchema,
          prompt,
        });
        const already = await db
          .select({ id: schema.findings.id })
          .from(schema.findings)
          .where(and(eq(schema.findings.roundId, round.id), eq(schema.findings.auditor, role)));
        if (already.length === 0) {
          await db.insert(schema.findings).values({
            roundId: round.id,
            auditor: role,
            agentSessionId: res.sessionRowId,
            payload: res.output,
          });
        }
        console.log(
          `  [${role}] ${res.output.nothing_found ? 'nothing found' : `${res.output.findings.length} finding(s)`}`,
        );
      });
    }
  }

  await withConcurrency(jobs, AGENT_CONCURRENCY);
}
