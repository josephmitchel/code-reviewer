import { format } from 'node:util';

const METHODS = ['log', 'info', 'warn', 'error'] as const;

/**
 * Prefixes every console line with the UTC time it was written, so a round that has gone quiet
 * in a CI log shows when it last moved. Installed once, at startup, for the commands that run
 * unattended; everything below the CLI keeps calling `console` as before.
 */
export function timestampConsole(now: () => Date = () => new Date()): void {
  for (const method of METHODS) {
    const write = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      // A line that opens with blank lines to set itself apart keeps them above the stamp.
      const text = format(...args);
      const gap = /^\n*/.exec(text)?.[0] ?? '';
      write(`${gap}[${now().toISOString()}] ${text.slice(gap.length)}`);
    };
  }
}

/**
 * A line a script reads back — the action greps `^outcome: ` and captures `next`'s PR number —
 * so it goes to stdout exactly as given, with no timestamp in front.
 */
export function printRaw(line: string): void {
  process.stdout.write(`${line}\n`);
}
