import type { ConcernLocation } from '../db/schema.js';
import { AUDITOR_CHARACTERISTICS } from '../stages/context.js';

/**
 * Everything the sweep writes to GitHub, as pure functions of database state — so the issue a
 * concern becomes and the digest can be tested without a repo or a network.
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
