import { describe, expect, it } from 'vitest';
import { classifyConflicts, type ReviewSlotConflict } from './intake.js';

/**
 * The repo's review slot is what keeps two reviews from auditing, fixing and pushing at the
 * same time. Deciding who holds it is the one place where being wrong is expensive in both
 * directions: steal a live review's slot and two pipelines push to two branches at once;
 * refuse to take a dead one's and every later PR queues behind a review that can never
 * finish. These pin the precedence — retire only what is provably dead, and treat anything
 * unproven as live.
 */

const NOW = Date.parse('2026-10-05T18:00:00Z');
const HOUR = 3_600_000;

/** A holder of the slot. `idleHours` is how long ago it last changed state. */
const conflict = (pr: number, state = 'awaiting_answers', idleHours = 0): ReviewSlotConflict => ({
  reviewId: pr * 10,
  pr,
  state,
  updatedAt: new Date(NOW - idleHours * HOUR),
});

/** Fake PR lookup: anything not listed comes back unknown, as a failed API call would. */
const states = (known: Record<number, string>) => (pr: number) => known[pr] ?? null;

describe('classifyConflicts', () => {
  it('claims the slot when nothing else holds it', () => {
    expect(classifyConflicts([], states({}), NOW)).toEqual({ retire: [], block: null });
  });

  it('is blocked by a review whose PR is still open', () => {
    const open = conflict(7);
    const result = classifyConflicts([open], states({ 7: 'open' }), NOW);
    expect(result.block).toEqual({ conflict: open, reason: 'open' });
    expect(result.retire).toEqual([]);
  });

  it('retires a review whose PR is closed and takes the slot', () => {
    const result = classifyConflicts([conflict(7, 'fixing')], states({ 7: 'closed' }), NOW);
    expect(result.block).toBeNull();
    expect(result.retire.map((r) => [r.pr, r.why])).toEqual([[7, 'PR is closed']]);
  });

  it('retires a merged PR the same way — it can never pass its own intake again', () => {
    const result = classifyConflicts([conflict(7)], states({ 7: 'merged' }), NOW);
    expect(result.block).toBeNull();
    expect(result.retire.map((r) => r.why)).toEqual(['PR is merged']);
  });

  it('treats an unfetchable PR as live rather than stealing its slot', () => {
    const unknown = conflict(7);
    const result = classifyConflicts([unknown], states({}), NOW);
    expect(result.block).toEqual({ conflict: unknown, reason: 'unknown' });
    expect(result.retire).toEqual([]);
  });

  it('retires the dead holders it got to, and leaves the ones past the blocker alone', () => {
    const live = conflict(8);
    const result = classifyConflicts([conflict(7), live, conflict(9)], states({ 7: 'closed', 8: 'open', 9: 'closed' }), NOW);
    expect(result.block).toEqual({ conflict: live, reason: 'open' });
    // PR #9 is never examined: a review we did not look at must not be marked abandoned.
    expect(result.retire.map((r) => r.pr)).toEqual([7]);
  });
});

/**
 * A run killed by GitHub's 6h cap or a cancellation never reaches any error handling, so its review
 * keeps whatever stage it was in and holds the repo's only slot. Nothing else in the system notices,
 * which made one dead run enough to stop every later PR from being reviewed until someone ran
 * `reset` by hand. The hazard in fixing it is the opposite mistake: `awaiting_answers` is idle for
 * days by design, and stealing ITS slot would break the one review that is behaving correctly.
 */
describe('classifyConflicts staleness', () => {
  const live = (pr: number) => states({ [pr]: 'open' });

  it('retires a holder stuck mid-work for longer than the job could possibly run', () => {
    const result = classifyConflicts([conflict(7, 'auditing', 8)], live(7), NOW);
    expect(result.block).toBeNull();
    expect(result.retire[0].why).toContain('presumed killed');
    expect(result.retire[0].why).toContain('auditing');
  });

  it('leaves a holder alone while its run could still legitimately be working', () => {
    expect(classifyConflicts([conflict(7, 'auditing', 2)], live(7), NOW).block).not.toBeNull();
  });

  it('never calls an awaiting_answers holder stale, however long it waits', () => {
    // Waiting for the owner is the design, not a hang: 20 days idle is still a live review.
    const result = classifyConflicts([conflict(7, 'awaiting_answers', 24 * 20)], live(7), NOW);
    expect(result.retire).toEqual([]);
    expect(result.block).toEqual({ conflict: conflict(7, 'awaiting_answers', 24 * 20), reason: 'open' });
  });

  it('still retires a long-idle awaiting_answers holder once its PR closes', () => {
    const result = classifyConflicts([conflict(7, 'awaiting_answers', 24 * 20)], states({ 7: 'closed' }), NOW);
    expect(result.retire.map((r) => r.why)).toEqual(['PR is closed']);
  });

  it('decides staleness without asking GitHub about the PR at all', () => {
    // The PR lookup can fail; a holder stuck for nine hours is dead regardless of what it says.
    const asked: number[] = [];
    const result = classifyConflicts([conflict(7, 'fixing', 9)], (pr) => {
      asked.push(pr);
      return null;
    }, NOW);
    expect(asked).toEqual([]);
    expect(result.block).toBeNull();
  });
});
