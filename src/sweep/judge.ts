import { and, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { JudgedIssue, JudgedTicket } from '../db/schema.js';
import {
  getIssue,
  getIssueRelations,
  listIssueComments,
  listIssueTimeline,
  listOpenIssuesByLabel,
  postComment,
  swapBlockedByForRelatesTo,
  updateIssue,
  type IssueComment,
  type IssueInfo,
} from '../github.js';
import { ANSWER_AUTHORITY } from '../stages/answers.js';
import { requireRound, type ConcernRow, type SweepCtx } from '../stages/context.js';
import { LABELS, parseDigestDismissals } from './render.js';

/**
 * The owner's decisions on tickets, applied before the audit so tonight's auditors already know them.
 *
 * - `wontfix` on an open ticket — the reviewer's own concern or anyone's — is a dismissal. The sweep
 *   closes it as not planned, drops `needs-judging` / `needs-work` / `needs-answer`, lifts its
 *   blocking edges (telling each dependent its blocker was dismissed), and, if the owner wrote a
 *   comment with the label, saves that comment as a repo policy so the point is never raised again.
 *   With no comment the ticket is simply closed and nothing is recorded.
 * - A concern whose issue the owner closed by hand is final: it is neither judged nor turned into
 *   policy. The concern is marked resolved so it stops being an open prior.
 * - A ticked box in the digest dismisses a minor, as policy.
 *
 * Verifying fixes is not done here any more: a concern is fixed through a PR that says
 * `Addresses #N`, which puts it in front of the ticket judge like any other ticket.
 */
export async function settleOwnerDecisions(ctx: SweepCtx): Promise<{ judged: JudgedIssue[]; tickets: JudgedTicket[] }> {
  const slug = ctx.repo.slug;
  const judged: JudgedIssue[] = [];
  const tickets: JudgedTicket[] = [];

  const concerns = await db
    .select()
    .from(schema.concerns)
    .where(
      and(eq(schema.concerns.repoId, ctx.repo.id), eq(schema.concerns.status, 'open'), isNotNull(schema.concerns.issueNumber)),
    );
  const concernByIssue = new Map(concerns.map((c) => [c.issueNumber!, c]));

  let dismissed: IssueInfo[] = [];
  try {
    dismissed = await listOpenIssuesByLabel(slug, LABELS.dismissed);
  } catch (err) {
    console.warn(`could not list ${LABELS.dismissed} tickets (${String(err).split('\n')[0]})`);
  }
  const handled = new Set<number>();
  for (const issue of dismissed) {
    handled.add(issue.number);
    const concern = concernByIssue.get(issue.number) ?? null;
    const reason = await dismissTicket(ctx, issue, concern);
    if (concern) judged.push({ slug: concern.slug, issueNumber: issue.number, verdict: 'dismissed', note: reason ?? '' });
    else tickets.push({ issueNumber: issue.number, title: issue.title, verdict: 'dismissed', prNumbers: [] });
  }

  for (const concern of concerns) {
    const issueNumber = concern.issueNumber!;
    if (handled.has(issueNumber)) continue;
    let issue: IssueInfo;
    try {
      issue = await getIssue(slug, issueNumber);
    } catch (err) {
      console.warn(`could not read issue #${issueNumber} for ${concern.slug} (${String(err).split('\n')[0]}) — skipped`);
      continue;
    }
    if (issue.state !== 'closed') continue;
    if (issue.labels.includes(LABELS.dismissed)) {
      // Labelled and closed in one go: the label is still the dismissal, and may carry a reason.
      const reason = await dismissTicket(ctx, issue, concern);
      judged.push({ slug: concern.slug, issueNumber, verdict: 'dismissed', note: reason ?? '' });
      continue;
    }
    await db
      .update(schema.concerns)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolutionNote: `Closed by hand (issue #${issueNumber}); final, not judged.`,
        lastSeenRoundId: requireRound(ctx).id,
      })
      .where(eq(schema.concerns.id, concern.id));
    judged.push({ slug: concern.slug, issueNumber, verdict: 'closed', note: 'closed by hand' });
    console.log(`  [closed:${concern.slug}] #${issueNumber} closed by hand — final`);
  }

  judged.push(...(await dismissTickedMinors(ctx)));
  return { judged, tickets };
}

/**
 * Apply one `wontfix`: record the reason (if any) as policy, resolve the concern (if it is one), lift
 * the blocking edges, strip the sweep's state labels and close the issue as not planned. Returns the
 * reason that was recorded, or null when the owner gave none.
 */
async function dismissTicket(ctx: SweepCtx, issue: IssueInfo, concern: ConcernRow | null): Promise<string | null> {
  const slug = ctx.repo.slug;
  const n = issue.number;

  let labeledAt: string | null = null;
  try {
    labeledAt = wontfixLabeledAt(await listIssueTimeline(slug, n));
  } catch (err) {
    console.warn(`could not read the timeline of #${n} (${String(err).split('\n')[0]})`);
  }
  let comments: IssueComment[] = [];
  try {
    comments = await listIssueComments(slug, n);
  } catch (err) {
    console.warn(`could not read the comments on #${n} (${String(err).split('\n')[0]})`);
  }
  const reason = dismissalReason(comments, labeledAt);

  if (concern) {
    if (reason) {
      await dismissConcern(ctx, concern, `the owner labelled issue #${n} \`${LABELS.dismissed}\``, reason);
    } else {
      await db
        .update(schema.concerns)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNote: `Dismissed: the owner labelled issue #${n} \`${LABELS.dismissed}\` without a reason.`,
          lastSeenRoundId: requireRound(ctx).id,
        })
        .where(eq(schema.concerns.id, concern.id));
    }
  } else if (reason) {
    await db.insert(schema.policies).values({
      repoId: ctx.repo.id,
      question: `Should "${issue.title.trim()}" (#${n}) be done?`,
      answer: `No — the owner dismissed it with \`${LABELS.dismissed}\`: ${reason}`,
    });
  }

  const lifted: number[] = [];
  try {
    const rel = await getIssueRelations(slug, n);
    for (const dep of rel.blocking) {
      await swapBlockedByForRelatesTo(dep.nodeId, rel.nodeId);
      lifted.push(dep.number);
      await postComment(
        slug,
        dep.number,
        `#${n}, which blocked this ticket, was dismissed (\`${LABELS.dismissed}\`). It now relates to this ticket instead. ` +
          'Decide whether this ticket still makes sense without it.',
      );
    }
  } catch (err) {
    console.warn(`  could not lift #${n}'s blocking edges (${String(err).split('\n')[0]})`);
  }

  const lines = [
    `Dismissed with \`${LABELS.dismissed}\`` +
      (reason
        ? '. Your comment is saved as a repo policy, so the reviewer will not raise this again.'
        : '. No comment was given, so nothing was saved as policy.'),
  ];
  if (lifted.length > 0) lines.push(`Unblocked #${lifted.join(', #')} — they now relate to this ticket instead of waiting on it.`);
  await postComment(slug, n, lines.join('\n\n'));

  const labels = issue.labels.filter((l) => l !== LABELS.needsJudging && l !== LABELS.needsWork && l !== LABELS.needsAnswer);
  const patch: Parameters<typeof updateIssue>[2] = {};
  if (labels.length !== issue.labels.length) patch.labels = labels;
  if (issue.state === 'open') {
    patch.state = 'closed';
    patch.stateReason = 'not_planned';
  }
  if (Object.keys(patch).length > 0) await updateIssue(slug, n, patch);
  console.log(`  [dismiss] #${n}${concern ? ` (${concern.slug})` : ''}${reason ? ' with a reason' : ''}`);
  return reason;
}

/** Pure: when the owner last put `wontfix` on the issue, or null if the timeline does not say. */
export function wontfixLabeledAt(timeline: Array<{ event: string; label: string | null; createdAt: string | null }>): string | null {
  let at: string | null = null;
  for (const e of timeline) if (e.event === 'labeled' && e.label === LABELS.dismissed && e.createdAt) at = e.createdAt;
  return at;
}

/** A comment written with the label can land a few minutes either side of it. */
const DISMISSAL_COMMENT_SLACK_MS = 15 * 60 * 1000;

/**
 * Pure: the owner's reason for a dismissal — the last comment by someone GitHub vouches for, written
 * with the label (not an older comment that answered something else). With no label time known, the
 * last such comment counts.
 */
export function dismissalReason(comments: IssueComment[], labeledAt: string | null): string | null {
  const since = labeledAt ? Date.parse(labeledAt) - DISMISSAL_COMMENT_SLACK_MS : Number.NEGATIVE_INFINITY;
  const own = comments.filter((c) => ANSWER_AUTHORITY.has(c.authorAssociation) && Date.parse(c.createdAt) >= since);
  const text = own.at(-1)?.body.trim();
  return text ? text : null;
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

/** A dismissal with a reason is an owner decision: it becomes policy, exactly as an answered question does. */
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
