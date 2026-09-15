export interface ParsedAnswers {
  answers: Map<number, string>;
  proceed: boolean;
}

/**
 * Deterministic parse of a reply comment: numbered `1. answer` / `1: answer` lines.
 * Partial replies are accepted — any subset of the expected ordinals counts; ordinals
 * outside the expected set are ignored. Returns null when nothing matches (caller falls
 * back to the LLM mapper).
 */
export function parseAnswers(body: string, expectedOrdinals: number[]): ParsedAnswers | null {
  const expected = new Set(expectedOrdinals);
  const answers = new Map<number, string>();
  let current: number | null = null;
  for (const line of body.trim().split('\n')) {
    const m = line.match(/^\s*(\d+)\s*[.):]\s+(.*)$/);
    if (m) {
      current = Number(m[1]);
      answers.set(current, m[2].trim());
    } else if (current !== null && line.trim() !== '') {
      answers.set(current, `${answers.get(current)}\n${line.trim()}`);
    }
  }
  for (const key of [...answers.keys()]) {
    if (!expected.has(key) || answers.get(key) === '') answers.delete(key);
  }
  if (answers.size === 0) return null;
  return { answers, proceed: true };
}
