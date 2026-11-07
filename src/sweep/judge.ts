import { and, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { JudgedIssue } from '../db/schema.js';
import { loadPrompt, runAgent, withConcurrency } from '../agents/run-agent.js';
import { judgeOutputSchema } from '../agents/schemas.js';
import {
  getCommit,
  getIssue,
  getPrFacts,
  listIssueComments,
  listIssueTimeline,
  postComment,
  updateIssue,
  type IssueComment,
  type IssueInfo,
  type MergedPrFacts,
} from '../github.js';
import { ANSWER_AUTHORITY } from '../stages/answers.js';
import { AGENT_CONCURRENCY, requireRound, requireWorkspace, type ConcernRow, type SweepCtx } from '../stages/context.js';
import { parseDigestDismissals } from './render.js';

/**
 * The owner closing a concern's issue is a claim that it is fixed; this stage checks the claim.
 *
 * Closed as completed → a judge agent reads the code at the sweep head and either resolves the
 * concern (a ✅ comment) or reopens the issue with its evidence. Closed as "not planned" → a
 * dismissal: the owner's comment becomes a repo policy so the auditors never raise it again, and
 * the concern is resolved without a judge. A ticked box in the digest dismisses a minor the same way.
 *
 * Nothing here needs a "judged" marker: an open concern whose issue is closed has, by definition,
 * not been judged yet — judging either resolves the concern or reopens the issue.
 */
export async function judgeClosedIssues(ctx: SweepCtx): Promise<JudgedIssue[]> {
  const round = requireRound(ctx);
  const workspace = requireWorkspace(ctx);
  const headSha = round.headSha;

  const candidates = await db
    .select()
    .from(schema.concerns)
    .where(
      and(
        eq(schema.concerns.repoId, ctx.repo.id),
        eq(schema.concerns.status, 'open'),
        isNotNull(schema.concerns.issueNumber),
      ),
    );

  const judged: JudgedIssue[] = [];
  const jobs = candidates.map((concern) => async () => {
    const issueNumber = concern.issueNumber!;
    let issue: IssueInfo;
    try {
      issue = await getIssue(ctx.repo.slug, issueNumber);
    } catch (err) {
      console.warn(`could not read issue #${issueNumber} for ${concern.slug} (${String(err).split('\n')[0]}) — skipped`);
      return;
    }
    if (issue.state !== 'closed') return;

    const comments = (await listIssueComments(ctx.repo.slug, issueNumber)).filter((c) =>
      ANSWER_AUTHORITY.has(c.authorAssociation),
    );

    if (issue.stateReason === 'not_planned') {
      const reason = comments.at(-1)?.body.trim() || '(no reason given)';
      await dismissConcern(ctx, concern, `the owner closed issue #${issueNumber} as not planned`, reason);
      await postComment(
        ctx.repo.slug,
        issueNumber,
        'Noted. This is saved as a repo policy, so the reviewer will not raise it again.',
      );
      judged.push({ slug: concern.slug, issueNumber, verdict: 'dismissed', note: reason });
      console.log(`  [dismiss:${concern.slug}] #${issueNumber}`);
      return;
    }

    const raisedSha = await raisedAtSha(concern, ctx.sweep.baseSha);
    const claim = await gatherClaim(ctx.repo.slug, issueNumber, comments);
    const res = await runAgent({
      roundId: round.id,
      role: `judge:${concern.slug}`,
      cwd: workspace,
      outputSchema: judgeOutputSchema,
      prompt: loadPrompt('sweep/judge.md', {
        HEAD_SHA: headSha,
        RAISED_SHA: raisedSha,
        ISSUE_NUMBER: String(issueNumber),
        CONCERN: renderConcern(concern),
        CLAIM: claim,
      }),
    });

    if (res.output.verdict === 'resolved') {
      await db
        .update(schema.concerns)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNote: `Judged resolved at ${headSha.slice(0, 10)}: ${res.output.evidence}`,
          lastSeenRoundId: round.id,
        })
        .where(eq(schema.concerns.id, concern.id));
      await postComment(
        ctx.repo.slug,
        issueNumber,
        `✅ **Verified fixed** at ${headSha.slice(0, 10)}.\n\n${res.output.evidence.trim()}`,
      );
    } else {
      await updateIssue(ctx.repo.slug, issueNumber, { state: 'open' });
      await postComment(
        ctx.repo.slug,
        issueNumber,
        `↩️ **Reopened.** A judge checked ${headSha.slice(0, 10)} and the problem is still there.\n\n` +
          `${res.output.evidence.trim()}\n\n` +
          'Close it again once it is fixed, or close it as *not planned* with a comment to dismiss it.',
      );
    }
    judged.push({ slug: concern.slug, issueNumber, verdict: res.output.verdict, note: res.output.evidence });
    console.log(`  [judge:${concern.slug}] ${res.output.verdict}`);
  });
  await withConcurrency(jobs, AGENT_CONCURRENCY);

  judged.push(...(await dismissTickedMinors(ctx)));
  return judged;
}

/** Minor concerns whose box the owner ticked in the digest. */
async function dismissTickedMinors(ctx: SweepCtx): Promise<JudgedIssue[]> {
  const digestNumber = ctx.repo.digestIssueNumber;
  if (!digestNumber) return [];
  let body: string;
  try {
    body = (await getIssue(ctx.repo.slug, digestNumber)).body;
  } catch (err) {
    console.warn(`could not read the digest issue #${digestNumber} (${String(err).split('\n')[0]})`);
    return [];
  }
  const ticked = parseDigestDismissals(body);
  if (ticked.length === 0) return [];

  const out: JudgedIssue[] = [];
  for (const slug of ticked) {
    const [concern] = await db
      .select()
      .from(schema.concerns)
      .where(and(eq(schema.concerns.repoId, ctx.repo.id), eq(schema.concerns.slug, slug)));
    if (!concern || concern.status !== 'open') continue;
    await dismissConcern(ctx, concern, `the owner ticked it off in the digest issue #${digestNumber}`, '(ticked in the digest)');
    out.push({ slug, issueNumber: digestNumber, verdict: 'dismissed', note: 'ticked in the digest' });
    console.log(`  [dismiss:${slug}] digest`);
  }
  return out;
}

/** A dismissal is an owner decision: it becomes policy, exactly as an answered question does. */
async function dismissConcern(ctx: SweepCtx, concern: ConcernRow, how: string, reason: string): Promise<void> {
  const round = requireRound(ctx);
  await db.transaction(async (tx) => {
    await tx.insert(schema.policies).values({
      repoId: ctx.repo.id,
      question: `Is "${concern.title}" (${concern.slug}) a concern worth raising?`,
      answer: `No — ${how}: ${reason}`,
    });
    await tx
      .update(schema.concerns)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolutionNote: `Dismissed: ${how}. ${reason}`,
        lastSeenRoundId: round.id,
      })
      .where(eq(schema.concerns.id, concern.id));
  });
}

/** The head of the round that last saw the concern — where it was last confirmed present. */
async function raisedAtSha(concern: ConcernRow, fallback: string): Promise<string> {
  if (!concern.lastSeenRoundId) return fallback;
  const [round] = await db
    .select({ headSha: schema.rounds.headSha })
    .from(schema.rounds)
    .where(eq(schema.rounds.id, concern.lastSeenRoundId));
  return round?.headSha ?? fallback;
}

function renderConcern(c: ConcernRow): string {
  return (
    `### ${c.slug} (${c.level})\n${c.title}\nLocations: ${c.locations
      .map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`)
      .join(', ')}\n\n${c.body}`
  );
}

/**
 * What the owner says fixed it, assembled from the issue's history: the commit that closed it,
 * merged PRs that referenced it (a `fixes #N` shows up as a cross-reference), commits that
 * mentioned it, and anything the owner wrote in the thread. Failures here are not fatal — a judge
 * with no claim still has the code.
 */
async function gatherClaim(repoSlug: string, issueNumber: number, comments: IssueComment[]): Promise<string> {
  const commits: Array<{ sha: string; message: string }> = [];
  const prs: MergedPrFacts[] = [];
  try {
    const timeline = await listIssueTimeline(repoSlug, issueNumber);
    const commitShas = new Set<string>();
    const prNumbers = new Set<number>();
    for (const e of timeline) {
      if ((e.event === 'closed' || e.event === 'referenced') && e.commitSha) commitShas.add(e.commitSha);
      if (e.event === 'cross-referenced' && e.source?.isPullRequest) prNumbers.add(e.source.number);
    }
    for (const n of prNumbers) {
      try {
        const pr = await getPrFacts(repoSlug, n);
        if (pr.merged) prs.push(pr);
      } catch (err) {
        console.warn(`could not read PR #${n} (${String(err).split('\n')[0]})`);
      }
    }
    for (const sha of commitShas) {
      try {
        commits.push({ sha, message: (await getCommit(repoSlug, sha)).message });
      } catch (err) {
        console.warn(`could not read commit ${sha.slice(0, 10)} (${String(err).split('\n')[0]})`);
      }
    }
  } catch (err) {
    console.warn(`could not read the timeline of #${issueNumber} (${String(err).split('\n')[0]})`);
  }
  return buildClaim({ commits, prs, comments });
}

export interface ClaimInput {
  commits: Array<{ sha: string; message: string }>;
  prs: MergedPrFacts[];
  /** Only comments from people GitHub vouches for — the owner, members, collaborators. */
  comments: IssueComment[];
}

/** Pure: the claim text the judge reads. */
export function buildClaim(input: ClaimInput): string {
  const parts: string[] = [];
  for (const pr of input.prs) {
    parts.push(
      `**Merged PR #${pr.number}: ${pr.title.trim()}**` +
        (pr.mergeCommitSha ? ` (merge commit ${pr.mergeCommitSha.slice(0, 10)})` : '') +
        (pr.body.trim() ? `\n\n${pr.body.trim()}` : ''),
    );
  }
  for (const c of input.commits) {
    parts.push(`**Commit ${c.sha.slice(0, 10)}**\n\n${c.message.trim()}`);
  }
  if (input.comments.length > 0) {
    parts.push(
      '**The owner wrote on the issue:**\n\n' +
        input.comments.map((c) => c.body.trim().split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n'),
    );
  }
  if (parts.length === 0) {
    return '(The issue was closed without a linked commit, PR or comment. Judge from the code alone.)';
  }
  return parts.join('\n\n');
}
