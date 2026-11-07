import { describe, expect, it } from 'vitest';
import { inferRetryState } from './loop.js';

/**
 * A sweep that died overnight is resumed by the next night's run. The retry point decides how much
 * is redone: every stage is safe to repeat, so the only thing to protect is a finished audit —
 * re-running ten auditors over a diff that was already synthesized is the one expensive mistake.
 */
describe('inferRetryState', () => {
  const sweep = (headSha: string | null) => ({ headSha }) as never;
  const round = (synthesizedAt: Date | null) => ({ synthesizedAt }) as never;

  it('starts over at intake when the head was never read or no round exists', () => {
    expect(inferRetryState({ sweep: sweep(null), round: null })).toBe('intake');
    expect(inferRetryState({ sweep: sweep('abc'), round: null })).toBe('intake');
    expect(inferRetryState({ sweep: sweep(null), round: round(null) })).toBe('intake');
  });

  it('re-judges (cheaply, from recorded sessions) when the round exists but was not synthesized', () => {
    expect(inferRetryState({ sweep: sweep('abc'), round: round(null) })).toBe('judging');
  });

  it('skips the audit once the round is synthesized, picking up at the ticket judges', () => {
    expect(inferRetryState({ sweep: sweep('abc'), round: round(new Date()) })).toBe('judging_tickets');
  });
});
