import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printRaw, timestampConsole } from './log.js';

const METHODS = ['log', 'info', 'warn', 'error'] as const;
const originals = Object.fromEntries(METHODS.map((m) => [m, console[m]]));
const AT = new Date('2026-10-13T21:40:05.123Z');

let written: string[];
beforeEach(() => {
  written = [];
  for (const m of METHODS) console[m] = (line: string) => void written.push(`${m}:${line}`);
});
afterEach(() => {
  for (const m of METHODS) console[m] = originals[m]!;
  vi.restoreAllMocks();
});

describe('timestampConsole', () => {
  it('stamps every console method with the UTC time the line was written', () => {
    timestampConsole(() => AT);
    console.log('resuming review', 7);
    console.error(new Error('boom').message);
    expect(written).toEqual([
      'log:[2026-10-13T21:40:05.123Z] resuming review 7',
      'error:[2026-10-13T21:40:05.123Z] boom',
    ]);
  });

  it('keeps a heading’s leading blank line above the stamp', () => {
    timestampConsole(() => AT);
    console.log('\n=== state: auditing ===');
    expect(written).toEqual(['log:\n[2026-10-13T21:40:05.123Z] === state: auditing ===']);
  });
});

describe('printRaw', () => {
  // The action greps `^outcome: ` from the run's output and captures `next` whole.
  it('writes the line unstamped, even once the console is stamped', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    timestampConsole(() => AT);
    printRaw('outcome: awaiting_answers');
    expect(out).toHaveBeenCalledWith('outcome: awaiting_answers\n');
  });
});
