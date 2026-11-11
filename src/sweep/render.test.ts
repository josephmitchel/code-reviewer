import { describe, expect, it } from 'vitest';
import {
  LABELS,
  STATUS_LABELS,
  concernStatus,
  issueLabels,
  parseDigestDismissals,
  renderDigestBody,
  renderIssueBody,
  withStatus,
} from './render.js';

/**
 * The sweep's whole output is text on GitHub that the owner reads and that the next
 * sweep reads back. These pin the parts that are contracts: the digest's tick boxes round-trip,
 * labels we manage never disturb the owner's, and a body says what to do next.
 */

const concern = {
  repoSlug: 'acme/app',
  slug: 'unbounded-sync-retry-loop',
  title: 'Sync retries forever on a 4xx',
  body: 'The retry loop in `sync()` has no cap.\n\nA permanent 400 keeps it spinning.',
  level: 'major',
  characteristics: ['reliability', 'performance-efficiency'],
  locations: [
    { file: 'src/lib/sync.ts', line: 42 },
    { file: 'src/lib/sync.test.ts', line: null },
  ],
  headSha: 'abcdef1234567890',
  guidance: [{ text: 'Cap or back off?', recommendation: 'Cap at 5 with exponential backoff.' }],
  questions: [],
};

describe('renderIssueBody', () => {
  it('links each location to the commit the concern was seen at', () => {
    const body = renderIssueBody(concern);
    expect(body).toContain('https://github.com/acme/app/blob/abcdef1234567890/src/lib/sync.ts#L42');
    expect(body).toContain('https://github.com/acme/app/blob/abcdef1234567890/src/lib/sync.test.ts)');
  });

  it('shows decided questions as the suggested direction, not as questions', () => {
    const body = renderIssueBody(concern);
    expect(body).toContain('## Suggested direction');
    expect(body).toContain('Cap at 5 with exponential backoff.');
    expect(body).not.toContain('## Questions for you');
  });

  it('numbers pending questions the way the owner replies to them, and shows answers once given', () => {
    const body = renderIssueBody({
      ...concern,
      questions: [
        { ordinal: 1, text: 'Should the user see a retry banner?', recommendation: 'Yes, after the third try.', answer: null },
        { ordinal: 2, text: 'Is the 2% cap published?', recommendation: 'Treat it as 2%.', answer: 'Yes, 2% per the card terms.' },
      ],
    });
    expect(body).toContain('## Questions for you');
    expect(body).toMatch(/1\. Should the user see a retry banner\?\n\s+_Recommended:_ Yes, after the third try\./);
    expect(body).toContain('## Answered');
    expect(body).toMatch(/2\. Is the 2% cap published\?\n\s+\*\*Answer:\*\* Yes, 2% per the card terms\./);
  });

  it('tells the owner how fixing, dismissing and the slug work', () => {
    const body = renderIssueBody(concern);
    expect(body).toContain('Addresses #<this issue>');
    expect(body).toContain('`wontfix`');
    expect(body).toContain('Closing this issue by hand is final');
    expect(body).not.toContain('fixes #');
    expect(body).toContain('`unbounded-sync-retry-loop`');
    expect(body).toContain('<!-- code-reviewer:concern unbounded-sync-retry-loop -->');
  });
});

describe('issueLabels', () => {
  it('keeps the owner labels and replaces only ours, old spellings included', () => {
    const labels = issueLabels(
      { level: 'moderate', characteristics: ['security'] },
      true,
      ['accessibility', 'code-reviewer', 'level: major', 'quality: reliability', 'major', 'reliability'],
    );
    expect(labels).toEqual(['accessibility', LABELS.concern, 'moderate', 'security', LABELS.needsAnswer]);
  });

  it('gives a concern exactly one kind', () => {
    expect(issueLabels({ level: 'major', characteristics: [] }, false, ['bug', 'spec'])).toEqual([
      LABELS.concern,
      'major',
      LABELS.readyForAgent,
    ]);
  });

  it('starts a concern as ready-for-agent, or needs-answer while a question is open', () => {
    expect(issueLabels({ level: 'major', characteristics: [] }, false)).toContain(LABELS.readyForAgent);
    expect(issueLabels({ level: 'major', characteristics: [] }, true)).toContain(LABELS.needsAnswer);
    expect(issueLabels({ level: 'major', characteristics: [] }, true)).not.toContain(LABELS.readyForAgent);
  });

  it('moves to ready-for-agent once every question is answered', () => {
    expect(issueLabels({ level: 'major', characteristics: [] }, false, [LABELS.needsAnswer])).toEqual([
      LABELS.concern,
      'major',
      LABELS.readyForAgent,
    ]);
  });

  it('never carries two statuses', () => {
    for (const existing of STATUS_LABELS) {
      for (const pending of [true, false]) {
        const labels = issueLabels({ level: 'moderate', characteristics: ['testing'] }, pending, [existing, LABELS.readyForAgent]);
        expect(labels.filter((l) => STATUS_LABELS.includes(l)), `${existing} pending=${pending}`).toHaveLength(1);
      }
    }
  });
});

describe('concernStatus', () => {
  it('leaves a dismissal, a pending judgement and a send-back alone, even with a question open', () => {
    expect(concernStatus(true, [LABELS.dismissed])).toBe(LABELS.dismissed);
    expect(concernStatus(true, [LABELS.needsJudging])).toBe(LABELS.needsJudging);
    expect(concernStatus(false, [LABELS.needsWork])).toBe(LABELS.needsWork);
  });

  it('keeps where the owner routed it once nothing is waiting on an answer', () => {
    expect(concernStatus(false, [LABELS.readyForHuman])).toBe(LABELS.readyForHuman);
    expect(concernStatus(true, [LABELS.readyForHuman])).toBe(LABELS.needsAnswer);
  });
});

describe('withStatus', () => {
  it('replaces every status with the one given, or with none', () => {
    expect(withStatus(['spec', LABELS.readyForAgent, LABELS.needsWork], LABELS.needsJudging)).toEqual(['spec', LABELS.needsJudging]);
    expect(withStatus(['spec', LABELS.needsJudging], null)).toEqual(['spec']);
  });
});

describe('digest', () => {
  const entries = [
    { slug: 'magic-number-timeout', title: 'Timeout is a bare 30000', body: 'Name it.\n\nMore.', locations: [{ file: 'src/a.ts', line: 3 }] },
    { slug: 'dup-helper', title: 'Two copies of slugify', body: 'Dedupe.', locations: [] },
  ];

  it('renders one unticked task line per minor, with the first paragraph beneath', () => {
    const body = renderDigestBody({ repoSlug: 'acme/app', headSha: 'abcdef1234567890', entries });
    expect(body).toContain('- [ ] `magic-number-timeout` **Timeout is a bare 30000** — [`src/a.ts:3`]');
    expect(body).toContain('\n  Name it.\n');
    expect(body).not.toContain('More.');
    expect(body).toContain('- [ ] `dup-helper` **Two copies of slugify**\n');
  });

  it('reads back exactly the boxes the owner ticked', () => {
    const body = renderDigestBody({ repoSlug: 'acme/app', headSha: 'abcdef1234567890', entries });
    const ticked = body.replace('- [ ] `dup-helper`', '- [x] `dup-helper`');
    expect(parseDigestDismissals(ticked)).toEqual(['dup-helper']);
    expect(parseDigestDismissals(body)).toEqual([]);
    expect(parseDigestDismissals(ticked.replace('- [x] `dup-helper`', '- [X] `dup-helper`'))).toEqual(['dup-helper']);
  });

  it('ignores ticked boxes that are not concern lines', () => {
    expect(parseDigestDismissals('- [x] remember to buy milk\n- [x] `ok-slug` fine')).toEqual(['ok-slug']);
  });

  it('says so when nothing is open', () => {
    expect(renderDigestBody({ repoSlug: 'acme/app', headSha: 'abcdef1234567890', entries: [] })).toContain('_Nothing open._');
  });
});
