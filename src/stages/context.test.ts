import { afterEach, describe, expect, it, vi } from 'vitest';
import { positiveIntEnv } from './context.js';

/**
 * The auditor fan-out is the one knob that has to change between a laptop and a 2-core CI
 * runner, so it reads the environment — which means a typo in a workflow file now decides how
 * many Claude Code subprocesses start at once. A bad value must fall back loudly, never to 0
 * (no auditors would run and the round would silently find nothing) or NaN.
 */

const VAR = 'REVIEWER_TEST_CONCURRENCY';

afterEach(() => {
  delete process.env[VAR];
  vi.restoreAllMocks();
});

describe('positiveIntEnv', () => {
  it('uses the fallback when unset', () => {
    expect(positiveIntEnv(VAR, 10)).toBe(10);
  });

  it('reads a positive integer', () => {
    process.env[VAR] = '4';
    expect(positiveIntEnv(VAR, 10)).toBe(4);
  });

  it('treats an empty or blank value as unset', () => {
    for (const blank of ['', '   ']) {
      process.env[VAR] = blank;
      expect(positiveIntEnv(VAR, 10)).toBe(10);
    }
  });

  it.each(['0', '-2', 'abc', '2.5', '1e2x'])('warns and falls back on %s', (bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[VAR] = bad;
    expect(positiveIntEnv(VAR, 10)).toBe(10);
    expect(warn).toHaveBeenCalledOnce();
  });
});
