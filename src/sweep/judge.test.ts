import { describe, expect, it } from 'vitest';
import { dismissalReason, wontfixLabeledAt } from './judge.js';

/**
 * A `wontfix` label is the owner's dismissal; a comment written with it is the reason that becomes
 * policy. The reason has to be the comment that came with the label — not an answer the owner gave
 * weeks earlier, and never something a passer-by wrote.
 */
describe('dismissalReason', () => {
  const c = (body: string, createdAt: string, authorAssociation = 'OWNER') => ({ id: 1, body, createdAt, authorLogin: 'joe', authorAssociation });

  it('takes the owner comment written with the label, including one a few minutes before it', () => {
    const comments = [
      c('1. Yes, after the third retry.', '2026-11-01T10:00:00Z'),
      c('Not worth it, the cap is enforced upstream.', '2026-11-09T19:55:00Z'),
    ];
    expect(dismissalReason(comments, '2026-11-09T20:00:00Z')).toBe('Not worth it, the cap is enforced upstream.');
  });

  it('is null when the only comments predate the label, or when nobody with authority wrote one', () => {
    expect(dismissalReason([c('1. Yes.', '2026-11-01T10:00:00Z')], '2026-11-09T20:00:00Z')).toBeNull();
    expect(dismissalReason([c('please drop this', '2026-11-09T20:01:00Z', 'NONE')], '2026-11-09T20:00:00Z')).toBeNull();
    expect(dismissalReason([], null)).toBeNull();
  });

  it('falls back to the last owner comment when the label time is unknown', () => {
    expect(dismissalReason([c('old', '2026-11-01T10:00:00Z'), c('new', '2026-11-02T10:00:00Z')], null)).toBe('new');
  });
});

describe('wontfixLabeledAt', () => {
  it('reads the latest wontfix labeling and ignores other labels', () => {
    expect(
      wontfixLabeledAt([
        { event: 'labeled', label: 'wontfix', createdAt: '2026-11-01T00:00:00Z' },
        { event: 'unlabeled', label: 'wontfix', createdAt: '2026-11-02T00:00:00Z' },
        { event: 'labeled', label: 'needs-work', createdAt: '2026-11-03T00:00:00Z' },
        { event: 'labeled', label: 'wontfix', createdAt: '2026-11-04T00:00:00Z' },
      ]),
    ).toBe('2026-11-04T00:00:00Z');
    expect(wontfixLabeledAt([{ event: 'labeled', label: 'bug', createdAt: '2026-11-01T00:00:00Z' }])).toBeNull();
  });
});
