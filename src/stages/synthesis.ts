import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { loadPrompt, runAgent } from '../agents/run-agent.js';
import { synthesisOutputSchema, type SynthesisOutput } from '../agents/schemas.js';
import { renderPolicies, renderTestResults } from './audit.js';
import { requireRound, requireWorkspace, type Ctx } from './context.js';

export async function runSynthesis(ctx: Ctx): Promise<void> {
  const round = requireRound(ctx);
  if (round.synthesizedAt) return;

  const findingRows = await db
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.roundId, round.id));
  const openConcerns = await db
    .select()
    .from(schema.concerns)
    .where(and(eq(schema.concerns.repoId, ctx.repo.id)));

  const openBlock =
    openConcerns.length === 0
      ? '(none)'
      : openConcerns
          .map(
            (c) =>
              `- \`${c.slug}\` [${c.status}] (${c.level}; ${c.characteristics.join(', ')}) ${c.title}`,
          )
          .join('\n');

  const failedSuites = (round.testResults ?? []).filter((t) => !t.passed);

  const basePrompt = loadPrompt('synthesis.md', {
    ROUND_NO: String(round.roundNo),
    ROUND_KIND: round.kind,
    FINDINGS: JSON.stringify(
      findingRows.map((f) => ({ auditor: f.auditor, ...(f.payload as object) })),
      null,
      2,
    ),
    OPEN_CONCERNS: openBlock,
    POLICIES: await renderPolicies(ctx.repo.id),
    TEST_RESULTS: renderTestResults(round.testResults),
  });

  let output: SynthesisOutput | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: your previous synthesis omitted concerns for these failed test suites: ` +
          `${failedSuites.map((t) => t.name).join(', ')}. Every failed suite must be represented by a concern.`;
    const res = await runAgent({
      roundId: round.id,
      role: attempt === 1 ? 'synthesis' : 'synthesis-retry',
      cwd: requireWorkspace(ctx),
      outputSchema: synthesisOutputSchema,
      model: 'opus',
      prompt,
    });
    output = res.output;
    const missing = failedSuites.filter(
      (t) =>
        !output!.concerns.some(
          (c) =>
            c.action !== 'resolve' &&
            (c.title.toLowerCase().includes(t.name.toLowerCase()) ||
              c.body.toLowerCase().includes(t.name.toLowerCase())),
        ),
    );
    if (missing.length === 0) break;
    if (attempt === 2) {
      console.warn(
        `synthesis still missing concerns for failed suites: ${missing.map((t) => t.name).join(', ')} — proceeding with what we have`,
      );
    }
  }
  if (!output) throw new Error('synthesis produced no output');

  const slugSet = new Set(openConcerns.map((c) => c.slug));
  await db.transaction(async (tx) => {
    for (const action of output!.concerns) {
      const existing = openConcerns.find((c) => c.slug === action.slug);
      if (action.action === 'create') {
        if (slugSet.has(action.slug)) {
          throw new Error(`synthesis tried to create duplicate slug ${action.slug}`);
        }
        await tx.insert(schema.concerns).values({
          repoId: ctx.repo.id,
          originReviewId: ctx.review.id,
          slug: action.slug,
          title: action.title,
          body: action.body,
          level: action.level,
          status: 'open',
          characteristics: action.characteristics,
          locations: action.locations,
          lastSeenRoundId: round.id,
          // Rising bar: late (verification-round) discoveries only block the gate when
          // they are major regressions the fix itself introduced.
          gateBlocking:
            round.kind === 'full' || (action.level === 'major' && action.introduced_by_fix),
        });
      } else if (existing) {
        if (action.action === 'carry' || action.action === 'reopen') {
          await tx
            .update(schema.concerns)
            .set({
              status: 'open',
              title: action.title,
              body: action.body,
              level: action.level,
              characteristics: action.characteristics,
              locations: action.locations,
              lastSeenRoundId: round.id,
              resolvedAt: null,
              resolutionNote: null,
            })
            .where(eq(schema.concerns.id, existing.id));
        } else if (action.action === 'resolve') {
          await tx
            .update(schema.concerns)
            .set({
              status: 'resolved',
              resolvedAt: new Date(),
              resolutionNote: action.body,
              lastSeenRoundId: round.id,
            })
            .where(eq(schema.concerns.id, existing.id));
        }
      } else {
        console.warn(`synthesis referenced unknown slug ${action.slug} with action ${action.action} — skipped`);
      }
    }

    // User-facing question ordinals are unique across the whole review, so replies like
    // "3. <answer>" stay unambiguous even when questions from earlier rounds are still pending.
    const priorOrdinals = await tx
      .select({ ordinal: schema.questions.ordinal })
      .from(schema.questions)
      .where(eq(schema.questions.reviewId, ctx.review.id));
    let ordinal = priorOrdinals.reduce((m, r) => Math.max(m, r.ordinal), 0) + 1;
    for (const q of output!.questions) {
      const concern = q.concern_slug
        ? (await tx
            .select({ id: schema.concerns.id })
            .from(schema.concerns)
            .where(
              and(eq(schema.concerns.repoId, ctx.repo.id), eq(schema.concerns.slug, q.concern_slug)),
            ))[0]
        : undefined;
      if (q.user_facing) {
        await tx.insert(schema.questions).values({
          reviewId: ctx.review.id,
          roundId: round.id,
          concernId: concern?.id ?? null,
          ordinal: ordinal++,
          text: q.text,
          recommendation: q.recommendation,
          userFacing: true,
        });
      } else {
        // Not a user-facing functionality decision: apply the recommendation immediately.
        // Deliberately no policies row — auto-applied decisions are not owner decisions
        // and stay vetoable; only real user answers become repo policy.
        await tx.insert(schema.questions).values({
          reviewId: ctx.review.id,
          roundId: round.id,
          concernId: concern?.id ?? null,
          ordinal: 0,
          text: q.text,
          recommendation: q.recommendation,
          userFacing: false,
          autoApplied: true,
          answer: `(auto-applied recommendation) ${q.recommendation}`,
          answeredAt: new Date(),
        });
      }
    }

    await tx
      .update(schema.rounds)
      .set({ synthesizedAt: new Date(), roundSummary: output!.round_summary })
      .where(eq(schema.rounds.id, round.id));
  });
  ctx.round = { ...round, synthesizedAt: new Date(), roundSummary: output.round_summary };
  console.log(
    `synthesis: ${output.concerns.length} concern action(s), ${output.questions.length} question(s)`,
  );
}
