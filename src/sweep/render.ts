import type { ConcernLocation } from '../db/schema.js';
import { AUDITOR_CHARACTERISTICS } from '../stages/context.js';

/**
 * Everything the sweep writes to GitHub, as pure functions of database state — so the issue a
 * concern becomes and the digest can be tested without a repo or a network.
 */

export const LABELS = {
  // Kind: what the ticket is. Exactly one per ticket.
  spec: 'spec',
  bug: 'bug',
  /** A concern the nightly sweep raised. The only kind the sweep itself applies. */
  concern: 'concern',
  // Status: who has to act next. Exactly one per open ticket.
  needsTriage: 'needs-triage',
  needsInfo: 'needs-info',
  needsAnswer: 'needs-answer',
  readyForHuman: 'ready-for-human',
  readyForAgent: 'ready-for-agent',
  /** The judge's send-back: the PR landed but did not finish the ticket, see the comment. */
  needsWork: 'needs-work',
  /** Put on any ticket when its PR merges: "a judge should check this landed properly". */
  needsJudging: 'needs-judging',
  /**
   * The owner's dismissal, on any ticket: GitHub's own label, which the triage skills already use.
   * The sweep closes the ticket as not planned and saves the comment that came with it as policy.
   */
  dismissed: 'wontfix',
  // Level and quality carry no prefix: the colour says which group a label belongs to.
  level: (level: string) => level,
  quality: (characteristic: string) => characteristic,
} as const;

export const KIND_LABELS: readonly string[] = [LABELS.spec, LABELS.bug, LABELS.concern];

export const STATUS_LABELS: readonly string[] = [
  LABELS.needsTriage,
  LABELS.needsInfo,
  LABELS.needsAnswer,
  LABELS.readyForHuman,
  LABELS.readyForAgent,
  LABELS.needsWork,
  LABELS.needsJudging,
  LABELS.dismissed,
];

const LEVEL_LABELS: readonly string[] = ['major', 'moderate'];

/**
 * One colour family per group, so a label's group is readable without a prefix: kinds are dark and
 * saturated, statuses are bright and coloured by who acts next (yellow the owner, green an agent,
 * blue the nightly judge), levels are neutral and darker when heavier, qualities one pale grey.
 */
const WAITING_ON_OWNER = 'f5d33d';
export const LABEL_DEFINITIONS: Array<{ name: string; color: string; description: string }> = [
  { name: LABELS.spec, color: '0550ae', description: 'Kind: a specified piece of work to build' },
  { name: LABELS.bug, color: 'b3261e', description: 'Kind: something is not working' },
  { name: LABELS.concern, color: '6639ba', description: 'Kind: raised by the nightly code reviewer sweep' },
  { name: LABELS.needsTriage, color: WAITING_ON_OWNER, description: 'Status: the owner has not yet decided what happens to this' },
  { name: LABELS.needsInfo, color: WAITING_ON_OWNER, description: 'Status: waiting on whoever raised it for more detail' },
  { name: LABELS.needsAnswer, color: WAITING_ON_OWNER, description: 'Status: the code reviewer has a question only the owner can answer' },
  { name: LABELS.readyForHuman, color: WAITING_ON_OWNER, description: 'Status: needs a person to implement it' },
  { name: LABELS.readyForAgent, color: '56d364', description: 'Status: fully specified, an agent can pick it up' },
  { name: LABELS.needsWork, color: 'ffa657', description: 'Status: the judge found it not finished; see its last comment' },
  { name: LABELS.needsJudging, color: '79c0ff', description: 'Status: its PR has landed; the nightly judge decides whether it is solved' },
  { name: LABELS.dismissed, color: 'ffffff', description: 'Status: this will not be worked on' },
  { name: LABELS.level('major'), color: '1f2328', description: 'Level: a defect, security hole or data-loss risk worth fixing soon' },
  { name: LABELS.level('moderate'), color: '6e7781', description: 'Level: a real problem worth an issue of its own' },
  ...AUDITOR_CHARACTERISTICS.map((c) => ({
    name: LABELS.quality(c),
    color: 'd8dee4',
    description: `Quality: ISO/IEC 25010 ${c}`,
  })),
];

/**
 * Names the scheme replaced. A repo that still has the old label gets it renamed in place, which
 * keeps it on every issue that carries it.
 */
export const RENAMED_LABELS: Array<{ from: string; to: string }> = [
  { from: 'code-reviewer', to: LABELS.concern },
  { from: 'enhancement', to: LABELS.spec },
  ...LEVEL_LABELS.map((l) => ({ from: `level: ${l}`, to: LABELS.level(l) })),
  ...AUDITOR_CHARACTERISTICS.map((c) => ({ from: `quality: ${c}`, to: LABELS.quality(c) })),
];

/**
 * Labels the sweep sets on its own concerns: the kind, the level and the quality (and their retired
 * spellings, so a rename that did not happen cannot leave both on an issue). Status is handled
 * separately by `withStatus`. Anything else on an issue is the owner's and is left alone.
 */
export function isManagedLabel(name: string): boolean {
  return (
    KIND_LABELS.includes(name) ||
    LEVEL_LABELS.includes(name) ||
    (AUDITOR_CHARACTERISTICS as readonly string[]).includes(name) ||
    RENAMED_LABELS.some((r) => r.from === name) ||
    name.startsWith('level: ') ||
    name.startsWith('quality: ')
  );
}

/** The labels with every status taken off and, unless `status` is null, that one status put on. */
export function withStatus(labels: string[], status: string | null): string[] {
  const rest = labels.filter((l) => !STATUS_LABELS.includes(l));
  return status === null ? rest : [...rest, status];
}

/**
 * The one status an open concern carries. A dismissal, a pending judgement and a send-back are
 * someone else's call and stand. Otherwise an unanswered question waits on the owner, and a concern
 * with nothing in its way is ready for an agent unless the owner already routed it elsewhere.
 */
export function concernStatus(pendingQuestions: boolean, existing: string[]): string {
  for (const held of [LABELS.dismissed, LABELS.needsJudging, LABELS.needsWork]) {
    if (existing.includes(held)) return held;
  }
  if (pendingQuestions) return LABELS.needsAnswer;
  for (const routed of [LABELS.readyForHuman, LABELS.needsInfo, LABELS.needsTriage]) {
    if (existing.includes(routed)) return routed;
  }
  return LABELS.readyForAgent;
}

/** The label set a concern's issue should carry: the owner's labels, plus ours for its current state. */
export function issueLabels(
  concern: { level: string; characteristics: string[] },
  pendingQuestions: boolean,
  existing: string[] = [],
): string[] {
  const ours = [LABELS.concern, LABELS.level(concern.level)];
  if (concern.characteristics[0]) ours.push(LABELS.quality(concern.characteristics[0]));
  const kept = withStatus(existing, null).filter((l) => !isManagedLabel(l));
  return [...kept, ...ours, concernStatus(pendingQuestions, existing)];
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
