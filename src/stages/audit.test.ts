import { describe, expect, it } from 'vitest';
import { renderTestResults } from './audit.js';
import { testsLine } from './report.js';

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

/**
 * The same distinction as renderTestResults, but this string goes to a human: it is the "Tests:" line
 * in the PR report and in the final gate comment. Calling a suite that never finished a FAIL there
 * tells the reader something untrue about their code.
 */
describe('testsLine', () => {
  const ctxWith = (results: unknown) => ({ round: { testResults: results } }) as never;
  const suite = (name: string, over = {}) => ({
    name,
    command: 'npm test',
    passed: true,
    ranAt: '2026-10-06T00:00:00.000Z',
    trimmedOutput: null,
    ...over,
  });

  it('says when nothing is configured', () => {
    expect(testsLine(ctxWith([]))).toContain('no suites configured');
  });

  it('reports all passing', () => {
    expect(testsLine(ctxWith([suite('unit'), suite('db')]))).toBe('2/2 suites pass');
  });

  it('names genuine failures', () => {
    const line = testsLine(ctxWith([suite('unit', { passed: false }), suite('db')]));
    expect(line).toContain('1 FAIL (unit)');
    expect(line).toContain('1/2 suites pass');
  });

  it('reports a killed suite as timed out rather than failed', () => {
    const line = testsLine(ctxWith([suite('db', { passed: false, timedOut: true }), suite('unit')]));
    expect(line).toContain('1 timed out (db)');
    expect(line).not.toMatch(/\bFAIL\b/);
  });

  it('distinguishes the two when both happen', () => {
    const line = testsLine(
      ctxWith([suite('unit', { passed: false }), suite('db', { passed: false, timedOut: true }), suite('e2e')]),
    );
    expect(line).toContain('1 FAIL (unit)');
    expect(line).toContain('1 timed out (db)');
  });
});
