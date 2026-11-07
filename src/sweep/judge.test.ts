import { describe, expect, it } from 'vitest';
import { buildClaim } from './judge.js';

/**
 * The judge reads "what the owner says fixed it" assembled from the issue's history. The
 * assembly has to survive every shape GitHub produces — closed by a commit, by a merged PR,
 * by hand with a comment, or by hand with nothing at all — without inventing a claim.
 */
describe('buildClaim', () => {
  const comment = (body: string) => ({ id: 1, body, createdAt: '2026-11-06T10:00:00Z', authorLogin: 'joe', authorAssociation: 'OWNER' });

  it('says so when the issue was closed with nothing attached', () => {
    expect(buildClaim({ commits: [], prs: [], comments: [] })).toMatch(/closed without a linked commit, PR or comment/);
  });

  it('leads with the merged PR, then commits, then what the owner wrote', () => {
    const text = buildClaim({
      prs: [{ number: 40, title: 'Cap sync retries', body: 'Fixes #12 by capping at 5.', merged: true, mergeCommitSha: 'deadbeefcafe1234' }],
      commits: [{ sha: 'abcdef1234567890', message: 'cap retries\n\nfixes #12' }],
      comments: [comment('Done in #40.\nAlso tidied the test.')],
    });
    expect(text.indexOf('Merged PR #40')).toBeLessThan(text.indexOf('Commit abcdef1234'));
    expect(text.indexOf('Commit abcdef1234')).toBeLessThan(text.indexOf('The owner wrote'));
    expect(text).toContain('(merge commit deadbeefca)');
    expect(text).toContain('Fixes #12 by capping at 5.');
    expect(text).toContain('> Done in #40.\n> Also tidied the test.');
  });

  it('quotes a comment-only closure as the claim', () => {
    const text = buildClaim({ prs: [], commits: [], comments: [comment('Handled in the refactor last week.')] });
    expect(text).toBe('**The owner wrote on the issue:**\n\n> Handled in the refactor last week.');
  });
});
