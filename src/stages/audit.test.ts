import { describe, expect, it } from 'vitest';
import { renderTestResults } from './audit.js';

/**
 * This string is what ten auditors read as the state of the repo's tests, and it is the one place a
 * killed command could be laundered into evidence of broken code. A suite that never finished has to
 * read as inconclusive, or the auditors spend a round explaining a failure that did not happen from a
 * log that was merely cut off.
 */
const suite = (over: Partial<Parameters<typeof renderTestResults>[0] extends (infer T)[] | null ? T : never> = {}) => ({
  name: 'unit',
  command: 'npm test',
  passed: false,
  ranAt: '2026-10-06T00:00:00.000Z',
  trimmedOutput: 'some output',
  ...over,
});

describe('renderTestResults', () => {
  it('says so when no suites are configured', () => {
    expect(renderTestResults(null)).toContain('No test suites');
    expect(renderTestResults([])).toContain('No test suites');
  });

  it('reports a pass without dumping output', () => {
    const out = renderTestResults([suite({ passed: true })]);
    expect(out).toContain('PASS');
    expect(out).not.toContain('some output');
  });

  it('reports a genuine failure as FAIL, with the log', () => {
    const out = renderTestResults([suite()]);
    expect(out).toContain('FAIL');
    expect(out).toContain('some output');
  });

  it('reports a killed suite as inconclusive rather than as a failure', () => {
    const out = renderTestResults([suite({ timedOut: true })]);
    expect(out).toContain('TIMED OUT');
    expect(out).toContain('says nothing either way');
    // The word the auditors act on must not appear for a suite that never finished.
    expect(out).not.toMatch(/\bFAIL\b/);
  });
});
