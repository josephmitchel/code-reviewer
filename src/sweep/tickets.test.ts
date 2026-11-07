import { describe, expect, it } from 'vitest';
import type { IssueTimelineEvent } from '../github.js';
import { referencedCommits, referencedPrs } from './tickets.js';

/**
 * A ticket's timeline is how the judge finds what landed for it. GitHub records a PR that says
 * `Addresses #N` as a cross-reference from a pull request, a commit that mentions it as a
 * `referenced` event, and anything else (comments, labels, mentions from other issues) as noise.
 */
describe('ticket timeline', () => {
  const ev = (event: string, extra: Partial<IssueTimelineEvent> = {}): IssueTimelineEvent => ({
    event,
    createdAt: null,
    commitSha: null,
    source: null,
    ...extra,
  });

  it('picks out pull requests and ignores issues that merely mention the ticket', () => {
    const timeline = [
      ev('labeled'),
      ev('cross-referenced', { source: { number: 40, isPullRequest: true } }),
      ev('cross-referenced', { source: { number: 41, isPullRequest: false } }),
      ev('cross-referenced', { source: { number: 40, isPullRequest: true } }),
      ev('commented'),
    ];
    expect(referencedPrs(timeline)).toEqual([40]);
  });

  it('picks out commits from referenced and closed events only', () => {
    const timeline = [
      ev('referenced', { commitSha: 'aaa' }),
      ev('closed', { commitSha: 'bbb' }),
      ev('closed'),
      ev('reopened', { commitSha: 'ccc' }),
      ev('referenced', { commitSha: 'aaa' }),
    ];
    expect(referencedCommits(timeline)).toEqual(['aaa', 'bbb']);
  });
});
