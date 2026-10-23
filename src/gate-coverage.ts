export interface PassedReview {
  id: number;
  /** Base of the review's latest full round: the commit everything it audited sits on. */
  lastFullBase: string | null;
  /** Commits its gate was posted on, carried ones included. */
  gated: string[];
}

/**
 * Commits whose code the reviews fully cover from `ownId`'s gated commit onward: its own gated
 * commits, plus those of any review whose last full round started from a covered commit — a PR
 * stacked on this one, then one stacked on that. A review based anywhere else never counts, even
 * when its code matches: its base was never reviewed as part of this PR.
 */
export function coveredCommits(ownId: number, reviews: PassedReview[]): Set<string> {
  const covered = new Set(reviews.find((r) => r.id === ownId)?.gated ?? []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of reviews) {
      if (r.id === ownId || !r.lastFullBase || !covered.has(r.lastFullBase)) continue;
      for (const sha of r.gated) {
        if (covered.has(sha)) continue;
        covered.add(sha);
        grew = true;
      }
    }
  }
  return covered;
}
