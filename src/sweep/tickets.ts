import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { JudgedTicket } from '../db/schema.js';
import { loadPrompt, MODELS, runAgent, withConcurrency } from '../agents/run-agent.js';
import { ticketJudgeOutputSchema } from '../agents/schemas.js';
import {
  getCommit,
  getPrFacts,
  listIssueTimeline,
  listOpenIssuesByLabel,
  postComment,
  updateIssue,
  type IssueInfo,
  type IssueTimelineEvent,
  type MergedPrFacts,
} from '../github.js';
import { renderPolicies, renderRepoStandards } from '../stages/audit.js';
import { AGENT_CONCURRENCY, requireRound, requireWorkspace, type ConcernRow, type SweepCtx } from '../stages/context.js';
import { changedFilePaths, isAncestor } from '../workspace.js';
import { LABELS } from './render.js';

/**
 * Tickets anyone opened — a coding agent working a spec, the owner, the reviewer itself does not
 * matter — whose work has landed and that carry `needs-judging` instead of having been closed.
 * A judge reads the ticket as the spec and the merged PR as the delivery, and either closes the
 * ticket or hands it back as `needs-work` with a brief for whoever picks it up next. A concern the
 * reviewer raised is judged the same way; `solved` also resolves it in the database.
 *
 * Runs after synthesis so the judge can see the concerns tonight's audit raised inside the
 * ticket's own files. Closing a ticket by hand never comes here: the label is the only way in.
 */
export async function judgeTickets(ctx: SweepCtx): Promise<JudgedTicket[]> {
  const round = requireRound(ctx);
  const workspace = requireWorkspace(ctx);
  const slug = ctx.repo.slug;

  let tickets: IssueInfo[];
  try {
    tickets = await listOpenIssuesByLabel(slug, LABELS.needsJudging);
  } catch (err) {
    console.warn(`could not list ${LABELS.needsJudging} tickets (${String(err).split('\n')[0]})`);
    return [];
  }
  if (tickets.length === 0) return [];

  const tonight = await db
    .select()
    .from(schema.concerns)
    .where(and(eq(schema.concerns.repoId, ctx.repo.id), eq(schema.concerns.status, 'open')));
  // The reviewer's own concerns, by issue: judged like any ticket, and resolved in the database on `solved`.
  const ownConcerns = new Map(tonight.filter((c) => c.issueNumber !== null).map((c) => [c.issueNumber!, c]));
  const standards = renderRepoStandards(workspace);
  const policies = await renderPolicies(ctx.repo.id);

  const out: JudgedTicket[] = [];
  const jobs = tickets.map((ticket) => async () => {
    if (ticket.labels.includes(LABELS.dismissed)) return; // a dismissal, settled earlier tonight
    const own = ownConcerns.get(ticket.number) ?? null;
    const landed = await gatherLanded(slug, ticket.number, workspace, round.headSha);
    if (landed.kind === 'pending') {
      console.log(`  [ticket #${ticket.number}] PR #${landed.prNumbers.join(', #')} not on ${ctx.sweep.branch} yet — waiting`);
      return;
    }
    if (landed.kind === 'nothing') {
      await updateIssue(slug, ticket.number, { labels: without(ticket.labels, LABELS.needsJudging) });
      await postComment(
        slug,
        ticket.number,
        `Nothing to judge: no merged pull request or commit references this ticket. ` +
          `Merge a PR whose body says \`Addresses #${ticket.number}\` and it is labelled \`${LABELS.needsJudging}\` again by itself. ` +
          'If it needs no code, close it directly.',
      );
      out.push({ issueNumber: ticket.number, title: ticket.title, verdict: 'nothing_to_judge', prNumbers: [] });
      console.log(`  [ticket #${ticket.number}] nothing to judge`);
      return;
    }

    const touched = new Set(landed.files);
    const inside = tonight.filter((c) => c !== own && c.locations.some((l) => touched.has(l.file)));
    const res = await runAgent({
      roundId: round.id,
      role: `ticket-judge:${ticket.number}`,
      cwd: workspace,
      outputSchema: ticketJudgeOutputSchema,
      // Decides whether someone's work is finished, and writes the brief for redoing it.
      model: MODELS.author,
      prompt: loadPrompt('sweep/ticket-judge.md', {
        HEAD_SHA: round.headSha,
        ISSUE_NUMBER: String(ticket.number),
        TICKET_TITLE: ticket.title,
        TICKET_BODY: ticket.body.trim() || '(no body)',
        LANDED: landed.text,
        REPO_STANDARDS: standards,
        POLICIES: policies,
        AUDIT_CONCERNS: renderAuditConcerns(inside),
      }),
    });

    const rest = without(ticket.labels, LABELS.needsJudging, LABELS.needsWork);
    if (res.output.verdict === 'solved') {
      // A solved ticket's open question is moot; the answer, if given, was banked earlier tonight.
      const closedLabels = without(rest, LABELS.needsAnswer);
      if (own) {
        await db
          .update(schema.concerns)
          .set({
            status: 'resolved',
            resolvedAt: new Date(),
            resolutionNote: `Judged solved at ${round.headSha.slice(0, 10)}: ${res.output.evidence}`,
            lastSeenRoundId: round.id,
          })
          .where(eq(schema.concerns.id, own.id));
      }
      await postComment(slug, ticket.number, `✅ **Judged solved** at ${round.headSha.slice(0, 10)}.\n\n${res.output.evidence.trim()}`);
      await updateIssue(slug, ticket.number, { state: 'closed', stateReason: 'completed', labels: closedLabels });
    } else {
      const linked = inside
        .filter((c) => c.issueNumber !== null && c.level !== 'minor')
        .map((c) => `- #${c.issueNumber} (${c.level}) ${c.title}`);
      await updateIssue(slug, ticket.number, { labels: [...rest, LABELS.needsWork] });
      await postComment(
        slug,
        ticket.number,
        `🔁 **Needs work.** A judge checked ${round.headSha.slice(0, 10)} against this ticket.\n\n` +
          `${res.output.evidence.trim()}\n\n` +
          (linked.length > 0 ? `Tonight's audit also raised these inside this work:\n${linked.join('\n')}\n\n` : '') +
          `Fix it in a follow-up PR that says \`Addresses #${ticket.number}\`; on merge this is labelled \`${LABELS.needsJudging}\` again.`,
      );
    }
    out.push({ issueNumber: ticket.number, title: ticket.title, verdict: res.output.verdict, prNumbers: landed.prNumbers });
    console.log(`  [ticket #${ticket.number}] ${res.output.verdict}`);
  });
  await withConcurrency(jobs, AGENT_CONCURRENCY);
  return out;
}

/** What has landed for a ticket, or why nothing can be judged yet. */
export type Landed =
  | { kind: 'judge'; text: string; files: string[]; prNumbers: number[] }
  /** A PR references the ticket but is not merged, or merged after tonight's head was read. */
  | { kind: 'pending'; prNumbers: number[] }
  | { kind: 'nothing' };

async function gatherLanded(slug: string, issueNumber: number, workspace: string, headSha: string): Promise<Landed> {
  let timeline: IssueTimelineEvent[] = [];
  try {
    timeline = await listIssueTimeline(slug, issueNumber);
  } catch (err) {
    console.warn(`could not read the timeline of #${issueNumber} (${String(err).split('\n')[0]})`);
  }
  const prs: MergedPrFacts[] = [];
  const commits: Array<{ sha: string; message: string }> = [];
  for (const n of referencedPrs(timeline)) {
    try {
      prs.push(await getPrFacts(slug, n));
    } catch (err) {
      console.warn(`could not read PR #${n} (${String(err).split('\n')[0]})`);
    }
  }
  for (const sha of referencedCommits(timeline)) {
    try {
      commits.push({ sha, message: (await getCommit(slug, sha)).message });
    } catch (err) {
      console.warn(`could not read commit ${sha.slice(0, 10)} (${String(err).split('\n')[0]})`);
    }
  }

  const onBranch: Array<{ label: string; sha: string; body: string }> = [];
  const waiting: number[] = [];
  for (const pr of prs) {
    if (pr.merged && pr.mergeCommitSha && (await isAncestor(workspace, pr.mergeCommitSha, headSha))) {
      onBranch.push({ label: `PR #${pr.number}: ${pr.title.trim()}`, sha: pr.mergeCommitSha, body: pr.body });
    } else {
      waiting.push(pr.number);
    }
  }
  for (const c of commits) {
    if (prs.some((p) => p.mergeCommitSha === c.sha)) continue;
    if (await isAncestor(workspace, c.sha, headSha)) onBranch.push({ label: `Commit ${c.sha.slice(0, 10)}`, sha: c.sha, body: c.message });
  }
  if (onBranch.length === 0) return waiting.length > 0 ? { kind: 'pending', prNumbers: waiting } : { kind: 'nothing' };

  const files = new Set<string>();
  const parts: string[] = [];
  for (const item of onBranch) {
    // `sha^1...sha` is the change a merge or squash commit brought in, whichever way it was merged.
    const changed = await changedFilePaths(workspace, `${item.sha}^1`, item.sha).catch(() => [] as string[]);
    for (const f of changed) files.add(f);
    parts.push(
      `### ${item.label}\n\nMerged as ${item.sha.slice(0, 10)}. See it with \`git show --stat ${item.sha}\` and \`git diff ${item.sha}^1 ${item.sha}\`.` +
        (changed.length > 0 ? `\n\nFiles: ${changed.map((f) => `\`${f}\``).join(', ')}` : '') +
        (item.body.trim() ? `\n\n${item.body.trim()}` : ''),
    );
  }
  return {
    kind: 'judge',
    text: parts.join('\n\n'),
    files: [...files],
    prNumbers: prs.filter((p) => onBranch.some((o) => o.sha === p.mergeCommitSha)).map((p) => p.number),
  };
}

/** Pure: PR numbers a ticket's timeline links it to. */
export function referencedPrs(timeline: IssueTimelineEvent[]): number[] {
  const out = new Set<number>();
  for (const e of timeline) if (e.event === 'cross-referenced' && e.source?.isPullRequest) out.add(e.source.number);
  return [...out];
}

/** Pure: commit SHAs a ticket's timeline links it to. */
export function referencedCommits(timeline: IssueTimelineEvent[]): string[] {
  const out = new Set<string>();
  for (const e of timeline) if ((e.event === 'referenced' || e.event === 'closed') && e.commitSha) out.add(e.commitSha);
  return [...out];
}

function renderAuditConcerns(concerns: ConcernRow[]): string {
  if (concerns.length === 0) return '(none — the auditors raised nothing inside these files tonight)';
  return concerns
    .map(
      (c) =>
        `- **${c.level}** \`${c.slug}\`${c.issueNumber ? ` (#${c.issueNumber})` : ''}: ${c.title}\n  ` +
        c.locations.map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`).join(', '),
    )
    .join('\n');
}

function without(labels: string[], ...drop: string[]): string[] {
  return labels.filter((l) => !drop.includes(l));
}
