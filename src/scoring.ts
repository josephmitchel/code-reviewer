export const LEVEL_POINTS: Record<string, number> = { major: 5, moderate: 2, minor: 1 };

export interface ScorableConcern {
  level: string;
  status: string;
  firstSeenAt: Date;
}

export interface Score {
  total: number;
  prior: number;
  fresh: number;
  resolvedThisRound: number;
}

export function scoreConcerns(
  concerns: ScorableConcern[],
  roundStartedAt: Date,
  resolvedThisRound: number,
): Score {
  let prior = 0;
  let fresh = 0;
  for (const c of concerns) {
    if (c.status !== 'open') continue;
    const points = LEVEL_POINTS[c.level] ?? 0;
    if (c.firstSeenAt < roundStartedAt) prior += points;
    else fresh += points;
  }
  return { total: prior + fresh, prior, fresh, resolvedThisRound };
}

export function formatScore(s: Score): string {
  return `Score: ${s.total} (prior: ${s.prior}, new: ${s.fresh}) — resolved this round: ${s.resolvedThisRound}`;
}
