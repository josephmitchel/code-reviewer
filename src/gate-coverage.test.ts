import { describe, expect, it } from 'vitest';
import { coveredCommits } from './gate-coverage.js';

describe('coveredCommits', () => {
  it('covers a stacked PR reviewed from this PR’s gated commit (#32 and #33)', () => {
    const covered = coveredCommits(31, [
      { id: 31, lastFullBase: 'main', gated: ['1340a04'] },
      { id: 32, lastFullBase: '1340a04', gated: ['bf1a013'] },
    ]);
    expect([...covered].sort()).toEqual(['1340a04', 'bf1a013']);
  });

  it('follows a stack of stacks', () => {
    const covered = coveredCommits(1, [
      { id: 3, lastFullBase: 'b', gated: ['c'] },
      { id: 2, lastFullBase: 'a', gated: ['b'] },
      { id: 1, lastFullBase: 'main', gated: ['a'] },
    ]);
    expect([...covered].sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores a review based anywhere else, whatever its code', () => {
    const covered = coveredCommits(1, [
      { id: 1, lastFullBase: 'main', gated: ['a'] },
      { id: 2, lastFullBase: 'unreviewed', gated: ['x'] },
    ]);
    expect([...covered]).toEqual(['a']);
  });

  it('covers nothing for a review that never gated', () => {
    expect(coveredCommits(1, [{ id: 1, lastFullBase: 'main', gated: [] }]).size).toBe(0);
  });
});
