import { describe, expect, it } from 'vitest';
import {
  LABELS,
  issueLabels,
  parseDigestDismissals,
  renderDigestBody,
  renderIssueBody,
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
  it('keeps the owner labels and replaces only ours', () => {
    const labels = issueLabels(
      { level: 'moderate', characteristics: ['security'] },
      true,
      ['bug', 'level: major', 'quality: reliability', 'good first issue'],
    );
    expect(labels).toEqual(['bug', 'good first issue', LABELS.reviewer, 'level: moderate', 'quality: security', LABELS.needsAnswer]);
  });

  it('drops needs-answer once every question is answered', () => {
    expect(issueLabels({ level: 'major', characteristics: [] }, false, [LABELS.needsAnswer])).toEqual([
      LABELS.reviewer,
      'level: major',
    ]);
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
