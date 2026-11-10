import type { ConcernLocation, JudgedIssue, JudgedTicket, SweepSummary } from '../db/schema.js';
import { AUDITOR_CHARACTERISTICS } from '../stages/context.js';

/**
 * Everything the sweep writes to GitHub, as pure functions of database state — so the issue a
 * concern becomes, the digest and the status page can be tested without a repo or a network.
 */

export const LABELS = {
  reviewer: 'code-reviewer',
  needsAnswer: 'needs-answer',
  /** Put on any ticket by whoever shipped its PR: "a judge should check this landed properly". */
  needsJudging: 'needs-judging',
  /** The judge's send-back: the PR landed but did not finish the ticket, see the comment. */
  needsWork: 'needs-work',
  /**
   * The owner's dismissal, on any ticket: GitHub's own label, which the triage skills already use.
   * The sweep closes the ticket as not planned and saves the comment that came with it as policy.
   */
  dismissed: 'wontfix',
  level: (level: string) => `level: ${level}`,
  quality: (characteristic: string) => `quality: ${characteristic}`,
} as const;

/** Declared with colours and descriptions so they do not appear on the repo in random colours. */
export const LABEL_DEFINITIONS: Array<{ name: string; color: string; description: string }> = [
  { name: LABELS.reviewer, color: '5319e7', description: 'Raised by the nightly code reviewer sweep' },
  { name: LABELS.needsAnswer, color: 'fbca04', description: 'The code reviewer has a question only the owner can answer' },
  { name: LABELS.needsJudging, color: '1d76db', description: 'Its PR has landed; the nightly judge decides whether the ticket is solved' },
  { name: LABELS.needsWork, color: 'e99695', description: 'The judge found the ticket not finished — see its last comment' },
  { name: LABELS.dismissed, color: 'ffffff', description: 'This will not be worked on' },
  { name: LABELS.level('major'), color: 'b60205', description: 'A defect, security hole or data-loss risk worth fixing soon' },
  { name: LABELS.level('moderate'), color: 'd93f0b', description: 'A real problem worth an issue of its own' },
  ...AUDITOR_CHARACTERISTICS.map((c) => ({
    name: LABELS.quality(c),
    color: '0e8a16',
    description: `ISO/IEC 25010 quality characteristic: ${c}`,
  })),
];

/** Labels the sweep owns. Anything else on an issue is the owner's and is left alone. */
export function isManagedLabel(name: string): boolean {
  return (
    name === LABELS.reviewer ||
    name === LABELS.needsAnswer ||
    name.startsWith('level: ') ||
    name.startsWith('quality: ')
  );
}

/** The label set an issue should carry: the owner's labels, plus ours for the concern's current state. */
export function issueLabels(
  concern: { level: string; characteristics: string[] },
  pendingQuestions: boolean,
  existing: string[] = [],
): string[] {
  const ours = [LABELS.reviewer, LABELS.level(concern.level)];
  if (concern.characteristics[0]) ours.push(LABELS.quality(concern.characteristics[0]));
  if (pendingQuestions) ours.push(LABELS.needsAnswer);
  return [...existing.filter((l) => !isManagedLabel(l)), ...ours];
}

export function permalink(repoSlug: string, sha: string, location: ConcernLocation): string {
  const anchor = location.line ? `#L${location.line}` : '';
  return `https://github.com/${repoSlug}/blob/${sha}/${location.file}${anchor}`;
}

function locationLine(repoSlug: string, sha: string, l: ConcernLocation): string {
  const label = `${l.file}${l.line ? `:${l.line}` : ''}`;
  return `[\`${label}\`](${permalink(repoSlug, sha, l)})`;
}

export interface IssueQuestion {
  ordinal: number;
  text: string;
  recommendation: string | null;
  answer: string | null;
}

export interface IssueGuidance {
  text: string;
  recommendation: string | null;
}

export interface IssueConcernInput {
  repoSlug: string;
  slug: string;
  title: string;
  body: string;
  level: string;
  characteristics: string[];
  locations: ConcernLocation[];
  /** The commit the locations refer to — the sweep head that last saw the concern. */
  headSha: string;
  /** Non-user-facing questions: decided by the synthesis, shown as the suggested direction. */
  guidance: IssueGuidance[];
  /** User-facing questions, answered or not, numbered as the owner replies to them. */
  questions: IssueQuestion[];
}

export function issueTitle(concern: { title: string }): string {
  return concern.title;
}

/** The marker line that identifies a body as the sweep's own, so a hand-edited body is recognisable. */
const FOOTER_START = '<!-- code-reviewer:concern ';

export function renderIssueBody(input: IssueConcernInput): string {
  const lines: string[] = [];
  lines.push(input.body.trim());
  lines.push('');
  if (input.locations.length > 0) {
    lines.push('## Where');
    lines.push('');
    for (const l of input.locations) lines.push(`- ${locationLine(input.repoSlug, input.headSha, l)}`);
    lines.push('');
  }
  if (input.guidance.length > 0) {
    lines.push('## Suggested direction');
    lines.push('');
    for (const g of input.guidance) {
      lines.push(`- ${g.text.trim()}`);
      if (g.recommendation) lines.push(`  ${g.recommendation.trim()}`);
    }
    lines.push('');
  }
  const pending = input.questions.filter((q) => q.answer === null);
  const answered = input.questions.filter((q) => q.answer !== null);
  if (pending.length > 0) {
    lines.push('## Questions for you');
    lines.push('');
    lines.push(
      'The right fix depends on a decision the code cannot make. Reply in a comment with numbered ' +
        'lines (`1. <answer>`), or "go with your recommendations". Your answers become repo policy ' +
        'and are never asked again.',
    );
    lines.push('');
    for (const q of pending) {
      lines.push(`${q.ordinal}. ${q.text.trim()}`);
      if (q.recommendation) lines.push(`   _Recommended:_ ${q.recommendation.trim()}`);
    }
    lines.push('');
  }
  if (answered.length > 0) {
    lines.push('## Answered');
    lines.push('');
    for (const q of answered) {
      lines.push(`${q.ordinal}. ${q.text.trim()}`);
      lines.push(`   **Answer:** ${(q.answer ?? '').trim()}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(
    `**Level:** ${input.level} · **Quality:** ${input.characteristics.join(', ')} · ` +
      `**Seen at:** ${input.headSha.slice(0, 10)} · **Slug:** \`${input.slug}\``,
  );
  lines.push('');
  lines.push(
    `**To fix it**, open a PR whose body says \`Addresses #<this issue>\`. When that PR merges, this issue is ` +
      `labelled \`${LABELS.needsJudging}\` and the next nightly sweep's judge closes it — or labels it ` +
      `\`${LABELS.needsWork}\` with what is still wrong. **To dismiss it**, add the \`${LABELS.dismissed}\` label; ` +
      'a comment saying why becomes a repo policy, so the reviewer will not raise it again, and the next sweep ' +
      'closes it as not planned. Closing this issue by hand is final: it is neither judged nor saved as policy.',
  );
  lines.push('');
  lines.push(`${FOOTER_START}${input.slug} -->`);
  return lines.join('\n');
}

export interface DigestEntry {
  slug: string;
  title: string;
  body: string;
  locations: ConcernLocation[];
}

export const DIGEST_TITLE = 'Code reviewer: minor findings';

/**
 * The rolling list of minor concerns. One task-list line per concern; ticking a box dismisses
 * that concern (it becomes a policy), which the next sweep reads back with `parseDigestDismissals`.
 * Fixing one needs no ceremony: the fix touches its file, so the next sweep's auditors re-check it.
 */
export function renderDigestBody(input: { repoSlug: string; headSha: string; entries: DigestEntry[] }): string {
  const lines: string[] = [];
  lines.push('# Minor findings');
  lines.push('');
  lines.push(
    'Small things the nightly sweep noticed that did not merit an issue each. This list is rewritten ' +
      'every night; it is not a to-do list, and nothing here blocks anything.',
  );
  lines.push('');
  lines.push(
    '- **To dismiss one**, tick its box. The next sweep records the dismissal as a repo policy and ' +
      'removes it from this list.',
  );
  lines.push(
    '- **To fix one**, just fix it. The next sweep re-checks any finding whose files changed and ' +
      'drops it when the problem is gone.',
  );
  lines.push('');
  if (input.entries.length === 0) {
    lines.push('_Nothing open._');
  } else {
    for (const e of input.entries) {
      const where = e.locations.map((l) => locationLine(input.repoSlug, input.headSha, l)).join(', ');
      lines.push(`- [ ] \`${e.slug}\` **${e.title.trim()}**${where ? ` — ${where}` : ''}`);
      const first = e.body.trim().split(/\n\s*\n/)[0]?.trim();
      if (first) lines.push(`  ${first.replaceAll('\n', ' ')}`);
    }
  }
  lines.push('');
  lines.push(`_Last sweep: ${input.headSha.slice(0, 10)}_`);
  return lines.join('\n');
}

/** Slugs whose task-list box the owner ticked. Hand edits elsewhere in the body are ignored. */
export function parseDigestDismissals(body: string): string[] {
  const slugs: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*`([a-z0-9][a-z0-9-]*)`/);
    if (m && m[1] !== ' ') slugs.push(m[2]);
  }
  return slugs;
}

export const STATUS_TITLE = 'Code reviewer status';

export interface StatusInput {
  repoSlug: string;
  branch: string;
  sweptAt: Date;
  baseSha: string;
  headSha: string;
  state: string;
  error: string | null;
  summary: SweepSummary | null;
  /** The synthesis's plain-language account of the night, null when nothing was audited. */
  roundSummary: string | null;
  openByLevel: { major: number; moderate: number; minor: number };
  digestIssueNumber: number | null;
  /** Open issues carrying an unanswered question. */
  needsAnswer: Array<{ issueNumber: number; title: string }>;
}

function issueRef(n: number): string {
  return `#${n}`;
}

function judgedLines(judged: JudgedIssue[], verdict: JudgedIssue['verdict']): string[] {
  return judged.filter((j) => j.verdict === verdict).map((j) => `  - ${issueRef(j.issueNumber)} \`${j.slug}\``);
}

function ticketLines(tickets: JudgedTicket[]): string[] {
  const lines: string[] = [];
  const by = (v: JudgedTicket['verdict']) =>
    tickets.filter((t) => t.verdict === v).map((t) => `  - ${issueRef(t.issueNumber)} ${t.title}`);
  const solved = by('solved');
  if (solved.length > 0) lines.push(`- **Tickets judged solved** and closed`, ...solved);
  const work = by('needs_work');
  if (work.length > 0) lines.push(`- **Tickets sent back** as \`${LABELS.needsWork}\``, ...work);
  const none = by('nothing_to_judge');
  if (none.length > 0) lines.push('- **Tickets with nothing to judge** (no merged PR behind them)', ...none);
  const dismissed = by('dismissed');
  if (dismissed.length > 0) lines.push(`- **Tickets dismissed** (\`${LABELS.dismissed}\`, closed as not planned)`, ...dismissed);
  return lines;
}

/** The owner's morning page: what happened last night and what is waiting on them. */
export function renderStatusBody(input: StatusInput): string {
  const lines: string[] = [];
  const when = input.sweptAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const range =
    input.baseSha === input.headSha
      ? `nothing new on \`${input.branch}\``
      : `\`${input.baseSha.slice(0, 10)}…${input.headSha.slice(0, 10)}\` on \`${input.branch}\`` +
        (input.summary ? ` (${input.summary.commits} commit${input.summary.commits === 1 ? '' : 's'})` : '');
  lines.push('# Code reviewer status');
  lines.push('');
  lines.push(`_Last sweep: ${when} · ${range} · ${input.state}_`);
  lines.push('');
  if (input.error) {
    lines.push('> ⛔ **The last sweep stopped.** It resumes where it left off on the next run.');
    lines.push('>');
    lines.push('> ```');
    for (const l of input.error.split('\n').slice(0, 12)) lines.push(`> ${l}`);
    lines.push('> ```');
    lines.push('');
  }

  lines.push('## Last night');
  lines.push('');
  if (input.baseSha === input.headSha) {
    lines.push('Nothing landed since the previous sweep, so there was nothing new to audit.');
  } else if (input.roundSummary) {
    lines.push(input.roundSummary.trim());
  } else {
    lines.push('_The audit did not finish._');
  }
  lines.push('');
  const s = input.summary;
  if (s) {
    const items: string[] = [];
    if (s.opened.length > 0) {
      items.push(`- **Opened ${s.opened.length} issue${s.opened.length === 1 ? '' : 's'}**`);
      for (const o of s.opened) items.push(`  - ${issueRef(o.issueNumber)} \`${o.slug}\` (${o.level})`);
    }
    const resolved = judgedLines(s.judged, 'resolved');
    if (resolved.length > 0) items.push('- **Verified fixed** (you closed these, a judge agreed)', ...resolved);
    const unresolved = judgedLines(s.judged, 'unresolved');
    if (unresolved.length > 0) items.push('- **Reopened** (you closed these, a judge found the problem still there)', ...unresolved);
    const dismissed = judgedLines(s.judged, 'dismissed');
    if (dismissed.length > 0) items.push(`- **Dismissed** (\`${LABELS.dismissed}\`; a reason given with it is now policy)`, ...dismissed);
    const closed = judgedLines(s.judged, 'closed');
    if (closed.length > 0) items.push('- **Closed by hand** (final, not judged)', ...closed);
    if (s.closedByAudit.length > 0) {
      items.push('- **Closed by the auditors** (fixed in passing by what landed)');
      for (const c of s.closedByAudit) items.push(`  - ${issueRef(c.issueNumber)} \`${c.slug}\``);
    }
    if (s.answered > 0) items.push(`- **Answers recorded:** ${s.answered}`);
    items.push(...ticketLines(s.tickets ?? []));
    if (items.length === 0) items.push('- No issues opened, closed, reopened or dismissed, and no tickets judged.');
    lines.push(...items);
    lines.push('');
  }

  lines.push('## Open');
  lines.push('');
  lines.push('| Level | Open |');
  lines.push('|---|---|');
  lines.push(`| major | ${input.openByLevel.major} |`);
  lines.push(`| moderate | ${input.openByLevel.moderate} |`);
  lines.push(
    `| minor | ${input.openByLevel.minor}${input.digestIssueNumber ? ` (${issueRef(input.digestIssueNumber)})` : ''} |`,
  );
  lines.push('');
  lines.push(
    `All of them: [open \`${LABELS.reviewer}\` issues](https://github.com/${input.repoSlug}/issues?q=is%3Aissue+is%3Aopen+label%3A${encodeURIComponent(LABELS.reviewer)}).`,
  );
  lines.push('');
  if (input.needsAnswer.length > 0) {
    lines.push('### Waiting on your answer');
    lines.push('');
    for (const n of input.needsAnswer) lines.push(`- ${issueRef(n.issueNumber)} ${n.title}`);
    lines.push('');
  }

  lines.push('## How this works');
  lines.push('');
  lines.push(
    `Every night the reviewer audits what landed on \`${input.branch}\` since the previous sweep against ` +
      'the ISO/IEC 25010 quality characteristics and files each major or moderate concern as an issue; ' +
      'minor ones go in the digest. Nothing is fixed for you and nothing blocks a merge.',
  );
  lines.push('');
  lines.push(
    `Every ticket closes by one rule, the reviewer's own issues included. A ticket is any issue a PR can address; ` +
      `one the reviewer opened carries \`${LABELS.reviewer}\`.`,
  );
  lines.push('');
  lines.push(
    `- **Fix or deliver** it through a PR whose body says \`Addresses #N\` (never \`Fixes\`, \`Closes\` or \`Resolves\`). ` +
      `On merge the ticket is labelled \`${LABELS.needsJudging}\` and the tickets it blocked are unblocked. The nightly judge then ` +
      `closes it as completed, or labels it \`${LABELS.needsWork}\` with what is missing, file by file.`,
  );
  lines.push(
    `- **Dismiss** it by adding the \`${LABELS.dismissed}\` label, with a comment if you want the reason kept. The next sweep closes it ` +
      'as not planned, lifts its blocking edges and saves the comment as repo policy; without a comment nothing is recorded.',
  );
  lines.push(`- **Answer** an issue labelled \`${LABELS.needsAnswer}\` in its thread. The answer becomes repo policy.`);
  lines.push('- **Close by hand** only a ticket with no code behind it (a decision, research, a spec whose slices are done). That is final and never judged.');
  lines.push(`- **Minor findings** live in the digest; tick a box there to dismiss one.`);
  lines.push('');
  lines.push('<!-- code-reviewer:status -->');
  return lines.join('\n');
}
