import {
  getIssue,
  getIssueRelations,
  getPrFacts,
  postComment,
  swapBlockedByForRelatesTo,
  updateIssue,
} from './github.js';
import { syncLabels } from './sweep/labels.js';
import { LABELS, withStatus } from './sweep/render.js';

/**
 * What happens to a ticket when the pull request addressing it merges — done here, on the merge
 * event, so no agent has to remember it. For each ticket the PR body names:
 *
 *   1. the ticket's status becomes `needs-judging`, which is how the nightly judge finds it;
 *   2. every ticket it blocks is unblocked, the "blocked by" edge becoming "relates to", so
 *      dependent work can start today rather than after the judge runs.
 *
 * `Addresses #N` is the convention. A PR that said `Closes #N` instead had its ticket closed by
 * GitHub on merge, which would hide it from the judge for good, so such a ticket is reopened and
 * labelled like the others; the process holds even when a PR slips. A concern the reviewer filed
 * is a ticket like any other: this is how its fix reaches a judge.
 */
export async function runLanded(repoSlug: string, prNumber: number): Promise<void> {
  const pr = await getPrFacts(repoSlug, prNumber);
  if (!pr.merged) {
    console.log(`PR #${prNumber} is not merged — nothing to do`);
    return;
  }
  const refs = ticketReferences(pr.body);
  const tickets = [...new Set([...refs.addressed, ...refs.closed])].sort((a, b) => a - b);
  if (tickets.length === 0) {
    console.log(`PR #${prNumber} names no tickets — nothing to do`);
    return;
  }
  console.log(`PR #${prNumber} merged, naming ticket(s) #${tickets.join(', #')}`);

  await syncLabels(repoSlug);

  for (const n of tickets) {
    let issue;
    try {
      issue = await getIssue(repoSlug, n);
    } catch (err) {
      console.warn(`  could not read #${n} (${String(err).split('\n')[0]}) — skipped`);
      continue;
    }
    const closedByKeyword = refs.closed.includes(n);
    if (issue.state === 'closed' && !closedByKeyword) {
      console.log(`  #${n} was closed by hand — final, not judged`);
      continue;
    }
    if (issue.labels.includes(LABELS.dismissed)) {
      console.log(`  #${n} is labelled ${LABELS.dismissed} — a dismissal, left for tonight's sweep`);
      continue;
    }
    let reopened = false;
    if (issue.state === 'closed') {
      await updateIssue(repoSlug, n, { state: 'open' });
      reopened = true;
      console.log(`  #${n} was closed by PR #${prNumber}'s keyword — reopened for the judge`);
    }
    // One status per ticket: `needs-judging` replaces whatever it carried — `ready-for-agent`, or
    // `needs-work` when this is the follow-up to a send-back.
    const labels = withStatus(issue.labels, LABELS.needsJudging);
    if (labels.length !== issue.labels.length || !issue.labels.includes(LABELS.needsJudging)) {
      await updateIssue(repoSlug, n, { labels });
    }

    const lifted: number[] = [];
    try {
      const rel = await getIssueRelations(repoSlug, n);
      for (const dep of rel.blocking) {
        await swapBlockedByForRelatesTo(dep.nodeId, rel.nodeId);
        lifted.push(dep.number);
      }
    } catch (err) {
      console.warn(`  could not lift #${n}'s blocking edges (${String(err).split('\n')[0]})`);
    }

    const lines = [
      `PR #${prNumber} landed. Labelled \`${LABELS.needsJudging}\`: the nightly judge decides whether this ticket is solved.`,
    ];
    if (reopened) {
      lines.push(
        `(The PR closed this ticket with a closing keyword; it is reopened so the judge can see it. Use \`Addresses #N\` in PR bodies.)`,
      );
    }
    if (lifted.length > 0) {
      lines.push(`Unblocked #${lifted.join(', #')} — they now relate to this ticket instead of waiting on it.`);
    }
    await postComment(repoSlug, n, lines.join('\n\n'));
    console.log(`  #${n}: labelled${lifted.length > 0 ? `, unblocked #${lifted.join(', #')}` : ''}`);
  }
}

export interface TicketReferences {
  /** `Addresses #N` — the convention. */
  addressed: number[];
  /** `Closes/Fixes/Resolves #N` — GitHub closed these on merge. */
  closed: number[];
}

const CLOSING = /^(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)$/i;

/**
 * Pure: the same-repo ticket numbers a PR body names after `Addresses` or a GitHub closing keyword,
 * including lists (`Addresses #3, #4 and #5`). Cross-repo references (`owner/repo#5`) are ignored.
 */
export function ticketReferences(body: string): TicketReferences {
  const addressed = new Set<number>();
  const closed = new Set<number>();
  const re = /\b(addresses|address|addressed|close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b\s*:?\s*((?:(?<![\w/])#\d+)(?:\s*(?:,|and|,\s*and)\s*(?<![\w/])#\d+)*)/gi;
  for (const m of body.matchAll(re)) {
    const target = CLOSING.test(m[1]) ? closed : addressed;
    for (const n of m[2].matchAll(/#(\d+)/g)) target.add(Number(n[1]));
  }
  return { addressed: [...addressed].sort((a, b) => a - b), closed: [...closed].sort((a, b) => a - b) };
}
