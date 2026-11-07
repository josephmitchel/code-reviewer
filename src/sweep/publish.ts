import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { SweepSummary } from '../db/schema.js';
import {
  createIssue,
  ensureLabel,
  getIssue,
  pinIssue,
  postComment,
  updateIssue,
  type IssueInfo,
} from '../github.js';
import { requireRound, type ConcernRow, type SweepCtx } from '../stages/context.js';
import {
  DIGEST_TITLE,
  LABEL_DEFINITIONS,
  LABELS,
  STATUS_TITLE,
  issueLabels,
  issueTitle,
  renderDigestBody,
  renderIssueBody,
  renderStatusBody,
  type IssueGuidance,
  type IssueQuestion,
} from './render.js';

/**
 * Concerns the sweep has itself seen. The database also holds concerns from the PR-review era;
 * those stay as auditor priors but get no issue until a sweep's audit carries them — otherwise
 * the first sweep would dump every stale PR concern on the owner at once.
 */
export async function sweepConcerns(ctx: SweepCtx): Promise<ConcernRow[]> {
  const roundIds = (
    await db
      .select({ id: schema.rounds.id })
      .from(schema.rounds)
      .innerJoin(schema.sweeps, eq(schema.rounds.sweepId, schema.sweeps.id))
      .where(eq(schema.sweeps.repoId, ctx.repo.id))
  ).map((r) => r.id);
  const seen = [isNotNull(schema.concerns.issueNumber), isNotNull(schema.concerns.originSweepId)];
  if (roundIds.length > 0) seen.push(inArray(schema.concerns.lastSeenRoundId, roundIds));
  return db
    .select()
    .from(schema.concerns)
    .where(and(eq(schema.concerns.repoId, ctx.repo.id), or(...seen)));
}

/** Concerns that get an issue of their own. Minors go in the digest. */
export function wantsIssue(c: ConcernRow): boolean {
  return c.level === 'major' || c.level === 'moderate';
}

/**
 * Bring GitHub in line with the database: open an issue for every new major or moderate concern,
 * refresh the body and labels of existing ones, close the ones the auditors found fixed, rewrite the
 * digest and the status page. Idempotent — a resumed sweep republishes and changes nothing it already
 * published.
 */
export async function publishIssues(
  ctx: SweepCtx,
  partial: Pick<SweepSummary, 'judged' | 'answered' | 'commits' | 'tickets'>,
): Promise<SweepSummary> {
  const round = requireRound(ctx);
  const slug = ctx.repo.slug;
  for (const label of LABEL_DEFINITIONS) await ensureLabel(slug, label);

  const concerns = await sweepConcerns(ctx);
  const opened: SweepSummary['opened'] = [];
  const closedByAudit: SweepSummary['closedByAudit'] = [];

  for (const concern of concerns) {
    const seenAt = await seenAtSha(concern, round.headSha);
    if (concern.status === 'open' && wantsIssue(concern)) {
      const { guidance, questions } = await questionsFor(concern.id);
      const pending = questions.some((q) => q.answer === null);
      const body = renderIssueBody({
        repoSlug: slug,
        slug: concern.slug,
        title: concern.title,
        body: concern.body,
        level: concern.level,
        characteristics: concern.characteristics,
        locations: concern.locations,
        headSha: seenAt,
        guidance,
        questions,
      });
      if (concern.issueNumber === null) {
        const issue = await createIssue(slug, {
          title: issueTitle(concern),
          body,
          labels: issueLabels(concern, pending),
        });
        await db.update(schema.concerns).set({ issueNumber: issue.number }).where(eq(schema.concerns.id, concern.id));
        opened.push({ slug: concern.slug, issueNumber: issue.number, level: concern.level });
        console.log(`  opened #${issue.number} for ${concern.slug} (${concern.level})`);
      } else {
        const issue = await readIssue(slug, concern.issueNumber);
        // A closed issue on an open concern is one the owner closed after tonight's judging ran;
        // the next sweep judges it. Never force it open from here.
        if (!issue || issue.state !== 'open') continue;
        const labels = issueLabels(concern, pending, issue.labels);
        const patch: Parameters<typeof updateIssue>[2] = {};
        if (issue.title !== issueTitle(concern)) patch.title = issueTitle(concern);
        if (issue.body.trim() !== body.trim()) patch.body = body;
        if (!sameSet(issue.labels, labels)) patch.labels = labels;
        if (Object.keys(patch).length > 0) {
          await updateIssue(slug, concern.issueNumber, patch);
          console.log(`  updated #${concern.issueNumber} for ${concern.slug}`);
        }
      }
    } else if (concern.status === 'resolved' && concern.issueNumber !== null && concern.lastSeenRoundId === round.id) {
      // Resolved tonight. By the auditors (prior_fixed) the issue is still open and gets closed here;
      // by a judge or a dismissal the owner closed it already and this is a read that changes nothing.
      // Concerns resolved on earlier nights are not re-read: that list only ever grows.
      const issue = await readIssue(slug, concern.issueNumber);
      if (!issue || issue.state !== 'open') continue;
      await postComment(
        slug,
        concern.issueNumber,
        `✅ **Fixed by what landed.** Tonight's auditors found this resolved at ${round.headSha.slice(0, 10)}.\n\n` +
          `${(concern.resolutionNote ?? '').trim()}`,
      );
      await updateIssue(slug, concern.issueNumber, {
        state: 'closed',
        stateReason: 'completed',
        labels: issue.labels.filter((l) => l !== LABELS.needsAnswer),
      });
      closedByAudit.push({ slug: concern.slug, issueNumber: concern.issueNumber });
      console.log(`  closed #${concern.issueNumber} for ${concern.slug} (fixed by the audit)`);
    }
  }

  await publishDigest(ctx, concerns);
  const summary: SweepSummary = { ...partial, opened, closedByAudit };
  await db.update(schema.sweeps).set({ summary, updatedAt: new Date() }).where(eq(schema.sweeps.id, ctx.sweep.id));
  ctx.sweep = { ...ctx.sweep, summary };
  return summary;
}

async function publishDigest(ctx: SweepCtx, concerns: ConcernRow[]): Promise<void> {
  const round = requireRound(ctx);
  const minors = concerns.filter((c) => c.status === 'open' && c.level === 'minor');
  const body = renderDigestBody({
    repoSlug: ctx.repo.slug,
    headSha: round.headSha,
    entries: minors.map((c) => ({ slug: c.slug, title: c.title, body: c.body, locations: c.locations })),
  });
  const number = await ensureLongLivedIssue(ctx, 'digestIssueNumber', DIGEST_TITLE, body, false);
  if (number === null) return;
  const issue = await readIssue(ctx.repo.slug, number);
  if (!issue) return;
  const patch: Parameters<typeof updateIssue>[2] = {};
  if (issue.body.trim() !== body.trim()) patch.body = body;
  if (issue.state === 'closed' && minors.length > 0) patch.state = 'open';
  if (Object.keys(patch).length > 0) await updateIssue(ctx.repo.slug, number, patch);
}

/** The status page is rewritten whatever happened, including when the sweep stopped. Best-effort. */
export async function publishStatus(ctx: SweepCtx, roundSummary: string | null): Promise<void> {
  try {
    const concerns = await sweepConcerns(ctx);
    const open = concerns.filter((c) => c.status === 'open');
    const pendingIssueIds = new Set(
      (
        await db
          .select({ concernId: schema.questions.concernId })
          .from(schema.questions)
          .where(and(isNotNull(schema.questions.sweepId), eq(schema.questions.userFacing, true), isNull(schema.questions.answeredAt)))
      ).map((r) => r.concernId),
    );
    const body = renderStatusBody({
      repoSlug: ctx.repo.slug,
      branch: ctx.sweep.branch,
      sweptAt: new Date(),
      baseSha: ctx.sweep.baseSha,
      headSha: ctx.sweep.headSha ?? ctx.sweep.baseSha,
      state: ctx.sweep.state,
      error: ctx.sweep.error,
      summary: ctx.sweep.summary,
      roundSummary,
      openByLevel: {
        major: open.filter((c) => c.level === 'major').length,
        moderate: open.filter((c) => c.level === 'moderate').length,
        minor: open.filter((c) => c.level === 'minor').length,
      },
      digestIssueNumber: ctx.repo.digestIssueNumber,
      needsAnswer: open
        .filter((c) => c.issueNumber !== null && pendingIssueIds.has(c.id))
        .map((c) => ({ issueNumber: c.issueNumber!, title: c.title })),
    });
    const number = await ensureLongLivedIssue(ctx, 'statusIssueNumber', STATUS_TITLE, body, true);
    if (number === null) return;
    const issue = await readIssue(ctx.repo.slug, number);
    if (!issue) return;
    const patch: Parameters<typeof updateIssue>[2] = {};
    if (issue.body.trim() !== body.trim()) patch.body = body;
    if (issue.state === 'closed') patch.state = 'open';
    if (Object.keys(patch).length > 0) await updateIssue(ctx.repo.slug, number, patch);
  } catch (err) {
    console.warn(`could not update the status issue (${String(err).split('\n')[0]})`);
  }
}

/**
 * The digest and the status page exist once per repo. Created on first use and remembered on the
 * repo row; returns the number, or null when creation failed (the caller carries on without it).
 */
async function ensureLongLivedIssue(
  ctx: SweepCtx,
  column: 'digestIssueNumber' | 'statusIssueNumber',
  title: string,
  body: string,
  pin: boolean,
): Promise<number | null> {
  const existing = ctx.repo[column];
  if (existing !== null) return existing;
  try {
    const issue = await createIssue(ctx.repo.slug, { title, body, labels: [LABELS.reviewer] });
    await db.update(schema.repos).set({ [column]: issue.number }).where(eq(schema.repos.id, ctx.repo.id));
    ctx.repo = { ...ctx.repo, [column]: issue.number };
    console.log(`  created "${title}" as #${issue.number}`);
    if (pin) await pinIssue(issue.nodeId);
    return issue.number;
  } catch (err) {
    console.warn(`could not create "${title}" (${String(err).split('\n')[0]})`);
    return null;
  }
}

async function readIssue(slug: string, number: number): Promise<IssueInfo | null> {
  try {
    return await getIssue(slug, number);
  } catch (err) {
    console.warn(`could not read issue #${number} (${String(err).split('\n')[0]})`);
    return null;
  }
}

/** The questions attached to a concern: user-facing ones for the owner, the rest as guidance. */
async function questionsFor(concernId: number): Promise<{ guidance: IssueGuidance[]; questions: IssueQuestion[] }> {
  const rows = await db.select().from(schema.questions).where(eq(schema.questions.concernId, concernId));
  const guidance: IssueGuidance[] = rows
    .filter((q) => !q.userFacing)
    .map((q) => ({ text: q.text, recommendation: q.recommendation }));
  const questions: IssueQuestion[] = rows
    .filter((q) => q.userFacing)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((q) => ({ ordinal: q.ordinal, text: q.text, recommendation: q.recommendation, answer: q.answer }));
  return { guidance, questions };
}

async function seenAtSha(concern: ConcernRow, fallback: string): Promise<string> {
  if (!concern.lastSeenRoundId) return fallback;
  const [round] = await db
    .select({ headSha: schema.rounds.headSha })
    .from(schema.rounds)
    .where(eq(schema.rounds.id, concern.lastSeenRoundId));
  return round?.headSha ?? fallback;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
