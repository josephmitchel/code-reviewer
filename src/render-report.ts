import type { Score } from './scoring.js';
import { formatScore } from './scoring.js';

export interface ReportConcern {
  slug: string;
  title: string;
  body: string;
  level: string;
  characteristics: string[];
  locations: Array<{ file: string; line: number | null }>;
  isPrior: boolean;
  /** Raw concerns.gateBlocking — false means "recorded for a future PR, never blocks this one". */
  gateBlocking: boolean;
  /** Full gate predicate: this concern currently counts against this review's gate. */
  blocking: boolean;
  /** Fix held back behind an unanswered user-facing question. */
  held: boolean;
}

export interface ReportQuestion {
  ordinal: number;
  text: string;
  recommendation: string | null;
  concernSlug: string | null;
}

export interface ReportInput {
  mode: 'round' | 'final';
  passWithWarnings?: boolean;
  roundNo: number;
  maxRounds: number;
  headSha: string;
  score: Score;
  testsLine: string;
  roundSummary: string | null;
  /** Open concerns of the review. */
  concerns: ReportConcern[];
  /** User-facing questions still awaiting the owner's answer. */
  questions: ReportQuestion[];
}

const LEVEL_BADGE: Record<string, string> = { major: '🔴 major', moderate: '🟠 moderate', minor: '🟡 minor' };

function statusLabel(c: ReportConcern): string {
  if (c.held) return 'held (awaiting your answer)';
  if (!c.gateBlocking) return 'recorded (non-blocking)';
  return c.isPrior ? 'prior' : 'new';
}

function concernTable(concerns: ReportConcern[]): string[] {
  const lines: string[] = [];
  // Deliberately narrow table — details, characteristics, and locations live in the blocks below.
  lines.push('| Concern | Level | Status |');
  lines.push('|---|---|---|');
  for (const c of concerns) {
    lines.push(`| \`${c.slug}\` | ${LEVEL_BADGE[c.level] ?? c.level} | ${statusLabel(c)} |`);
  }
  lines.push('');
  for (const c of concerns) {
    const where = c.locations.map((l) => `\`${l.file}${l.line ? `:${l.line}` : ''}\``).join(', ');
    lines.push(`<details><summary><b>${c.slug}</b> — ${escapeHtml(c.title)}</summary>`);
    lines.push('');
    lines.push(`**Characteristics:** ${c.characteristics.join(', ')}  `);
    if (where) lines.push(`**Where:** ${where}`);
    lines.push('');
    lines.push(c.body);
    lines.push('');
    lines.push('</details>');
  }
  return lines;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  if (input.mode === 'round') {
    lines.push(`# Code Reviewer — round ${input.roundNo} of ${input.maxRounds}`);
  } else {
    lines.push(input.passWithWarnings ? '# Code Reviewer — passed with warnings ⚠️' : '# Code Reviewer — passed ✅');
  }
  lines.push('');
  lines.push(`Audited \`${input.headSha.slice(0, 10)}\`. ${formatScore(input.score)}`);
  lines.push(`Tests: ${input.testsLine}`);
  lines.push('');

  lines.push(`## Round ${input.roundNo} Report`);
  lines.push('');
  if (input.roundSummary) {
    lines.push(input.roundSummary.trim());
    lines.push('');
  }

  if (input.mode === 'round') {
    if (input.concerns.length === 0) {
      lines.push('No open concerns.');
      lines.push('');
    } else {
      lines.push('## Concerns');
      lines.push('');
      lines.push(...concernTable(input.concerns));
      lines.push('');
    }
    if (input.questions.length > 0) {
      lines.push('## Questions');
      lines.push('');
      for (const q of input.questions) {
        lines.push(`${q.ordinal}. ${q.text}${q.concernSlug ? ` _(re: ${q.concernSlug})_` : ''}`);
        if (q.recommendation) {
          lines.push(`   - **Recommended:** ${q.recommendation}`);
        }
      }
      lines.push('');
      lines.push(
        '---\n_Reply with numbered answers (`' +
          `${input.questions[0].ordinal}. <answer>` +
          '`), or `go with your recommendations` to accept them all. Fixes for everything else are already ' +
          'proceeding — your answers unblock the held concerns in the next round. ' +
          'Answers are saved as repo policy and never re-asked._',
      );
    }
  } else {
    const warnings = input.concerns.filter((c) => c.blocking);
    const info = input.concerns.filter((c) => !c.blocking);
    if (warnings.length > 0 || input.questions.length > 0) {
      lines.push('## Warnings');
      lines.push('');
      lines.push('_The round cap was reached, so the gate passed with these unresolved:_');
      lines.push('');
      if (warnings.length > 0) {
        lines.push(...concernTable(warnings));
        lines.push('');
      }
      if (input.questions.length > 0) {
        lines.push('**Unanswered questions:**');
        lines.push('');
        for (const q of input.questions) {
          lines.push(`${q.ordinal}. ${q.text}${q.concernSlug ? ` _(re: ${q.concernSlug})_` : ''}`);
          if (q.recommendation) lines.push(`   - **Recommended:** ${q.recommendation}`);
        }
        lines.push('');
      }
    }
    if (info.length > 0) {
      lines.push('## Remaining notes (not blocking)');
      lines.push('');
      for (const c of info) {
        lines.push(`- **${c.slug}** (${c.level}): ${c.title}`);
      }
      lines.push('');
    }
    if (warnings.length === 0 && input.questions.length === 0 && info.length === 0) {
      lines.push('No open concerns.');
    }
  }
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
