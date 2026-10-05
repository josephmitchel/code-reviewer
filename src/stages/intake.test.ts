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

const conflict = (pr: number, state = 'awaiting_answers'): ReviewSlotConflict => ({
  reviewId: pr * 10,
  pr,
  state,
});

/** Fake PR lookup: anything not listed comes back unknown, as a failed API call would. */
const states = (known: Record<number, string>) => (pr: number) => known[pr] ?? null;

describe('classifyConflicts', () => {
  it('claims the slot when nothing else holds it', () => {
    expect(classifyConflicts([], states({}))).toEqual({ retire: [], block: null });
  });

  it('is blocked by a review whose PR is still open', () => {
    const open = conflict(7);
    const result = classifyConflicts([open], states({ 7: 'open' }));
    expect(result.block).toEqual({ conflict: open, reason: 'open' });
    expect(result.retire).toEqual([]);
  });

  it('retires a review whose PR is closed and takes the slot', () => {
    const result = classifyConflicts([conflict(7, 'fixing')], states({ 7: 'closed' }));
    expect(result.block).toBeNull();
    expect(result.retire).toEqual([{ reviewId: 70, pr: 7, state: 'fixing', prState: 'closed' }]);
  });

  it('retires a merged PR the same way — it can never pass its own intake again', () => {
    const result = classifyConflicts([conflict(7)], states({ 7: 'merged' }));
    expect(result.block).toBeNull();
    expect(result.retire.map((r) => r.prState)).toEqual(['merged']);
  });

  it('treats an unfetchable PR as live rather than stealing its slot', () => {
    const unknown = conflict(7);
    const result = classifyConflicts([unknown], states({}));
    expect(result.block).toEqual({ conflict: unknown, reason: 'unknown' });
    expect(result.retire).toEqual([]);
  });

  it('retires the dead holders it got to, and leaves the ones past the blocker alone', () => {
    const live = conflict(8);
    const result = classifyConflicts([conflict(7), live, conflict(9)], states({ 7: 'closed', 8: 'open', 9: 'closed' }));
    expect(result.block).toEqual({ conflict: live, reason: 'open' });
    // PR #9 is never examined: a review we did not look at must not be marked abandoned.
    expect(result.retire.map((r) => r.pr)).toEqual([7]);
  });
});
