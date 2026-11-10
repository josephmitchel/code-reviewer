import { describe, expect, it } from 'vitest';
import {
  LABELS,
  issueLabels,
  parseDigestDismissals,
  renderDigestBody,
  renderIssueBody,
  renderStatusBody,
} from './render.js';

/**
 * The sweep's whole output is text on GitHub that the owner reads in the morning and that the next
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

describe('renderStatusBody', () => {
  const base = {
    repoSlug: 'acme/app',
    branch: 'main',
    sweptAt: new Date('2026-11-07T07:20:00Z'),
    baseSha: '1111111111aaaaaaaa',
    headSha: '2222222222bbbbbbbb',
    state: 'done',
    error: null,
    roundSummary: 'The export button could save a file twice.',
    openByLevel: { major: 1, moderate: 3, minor: 4 },
    digestIssueNumber: 7,
    needsAnswer: [{ issueNumber: 12, title: 'Retry banner wording' }],
    summary: {
      commits: 5,
      answered: 2,
      opened: [{ slug: 'double-export', issueNumber: 14, level: 'major' }],
      closedByAudit: [{ slug: 'old-nit', issueNumber: 9 }],
      judged: [
        { slug: 'a', issueNumber: 10, verdict: 'resolved' as const, note: '' },
        { slug: 'b', issueNumber: 11, verdict: 'unresolved' as const, note: '' },
        { slug: 'c', issueNumber: 13, verdict: 'dismissed' as const, note: '' },
        { slug: 'd', issueNumber: 15, verdict: 'closed' as const, note: '' },
      ],
    },
  };

  it('puts last night first and names every issue that moved', () => {
    const body = renderStatusBody(base);
    expect(body).toContain('`1111111111…2222222222` on `main` (5 commits)');
    expect(body).toContain('The export button could save a file twice.');
    expect(body).toContain('#14 `double-export` (major)');
    expect(body).toContain('**Verified fixed**');
    expect(body).toContain('#10 `a`');
    expect(body).toContain('**Reopened**');
    expect(body).toContain('#11 `b`');
    expect(body).toContain('**Dismissed**');
    expect(body).toContain('#13 `c`');
    expect(body).toContain('**Closed by hand**');
    expect(body).toContain('#15 `d`');
    expect(body).toContain('#9 `old-nit`');
    expect(body).toContain('**Answers recorded:** 2');
    expect(body).toContain('| minor | 4 (#7) |');
    expect(body).toContain('- #12 Retry banner wording');
  });

  it('lists judged tickets by verdict', () => {
    const body = renderStatusBody({
      ...base,
      summary: {
        ...base.summary,
        tickets: [
          { issueNumber: 20, title: 'Add CSV export', verdict: 'solved', prNumbers: [41] },
          { issueNumber: 21, title: 'Retry on 5xx', verdict: 'needs_work', prNumbers: [42] },
          { issueNumber: 22, title: 'Decide on cache TTL', verdict: 'nothing_to_judge', prNumbers: [] },
          { issueNumber: 23, title: 'Dark mode', verdict: 'dismissed', prNumbers: [] },
        ],
      },
    });
    expect(body).toContain('**Tickets dismissed**');
    expect(body).toContain('  - #23 Dark mode');
    expect(body).toContain('**Tickets judged solved**');
    expect(body).toContain('  - #20 Add CSV export');
    expect(body).toContain('**Tickets sent back** as `needs-work`');
    expect(body).toContain('  - #21 Retry on 5xx');
    expect(body).toContain('**Tickets with nothing to judge**');
    expect(body).toContain('  - #22 Decide on cache TTL');
    expect(body).toContain('Every ticket closes by one rule');
    expect(body).toContain('`Addresses #N`');
  });

  it('says plainly when nothing landed', () => {
    const body = renderStatusBody({ ...base, headSha: base.baseSha, roundSummary: null, summary: null });
    expect(body).toContain('nothing new on `main`');
    expect(body).toContain('Nothing landed since the previous sweep');
  });

  it('shows the error of a stopped sweep at the top', () => {
    const body = renderStatusBody({ ...base, state: 'failed', error: 'setup command failed:\nnpm ERR! boom' });
    expect(body.indexOf('The last sweep stopped')).toBeLessThan(body.indexOf('## Last night'));
    expect(body).toContain('> npm ERR! boom');
  });
});
