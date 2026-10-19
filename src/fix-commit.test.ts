import { describe, expect, it } from 'vitest';
import { isOwnFix } from './fix-commit.js';

const ours = '338258166+jm-code-reviewer[bot]@users.noreply.github.com';
const round = {
  headSha: 'aaa',
  plan: { commitMessage: 'Settle link re-rating order\n\nAddresses review concerns:\n- some-slug' },
};

describe('isOwnFix', () => {
  it('accepts a commit authored under our identity', () => {
    expect(isOwnFix({ parents: ['zzz'], authorEmail: ours, message: 'anything' }, round, ours)).toBe(true);
  });

  it('accepts the planned subject on the audited head under another identity', () => {
    const commit = {
      parents: ['aaa'],
      authorEmail: 'noreply@anthropic.com',
      message: 'Settle link re-rating order\n\nA different body, with deviation notes.',
    };
    expect(isOwnFix(commit, round, ours)).toBe(true);
  });

  it('rejects the planned subject on any other parent', () => {
    const commit = { parents: ['bbb'], authorEmail: 'owner@example.com', message: 'Settle link re-rating order' };
    expect(isOwnFix(commit, round, ours)).toBe(false);
  });

  it('rejects a merge onto the audited head', () => {
    const commit = { parents: ['aaa', 'ccc'], authorEmail: 'owner@example.com', message: 'Settle link re-rating order' };
    expect(isOwnFix(commit, round, ours)).toBe(false);
  });

  it("rejects the owner's own commit on the audited head", () => {
    const commit = { parents: ['aaa'], authorEmail: 'owner@example.com', message: 'Tweak copy' };
    expect(isOwnFix(commit, round, ours)).toBe(false);
  });

  it('rejects everything but our identity when there is no plan', () => {
    const commit = { parents: ['aaa'], authorEmail: 'owner@example.com', message: 'Settle link re-rating order' };
    expect(isOwnFix(commit, { headSha: 'aaa', plan: null }, ours)).toBe(false);
  });

  it('never matches an empty author against a missing identity', () => {
    expect(isOwnFix({ parents: ['zzz'], authorEmail: '', message: 'x' }, round, null)).toBe(false);
  });
});
