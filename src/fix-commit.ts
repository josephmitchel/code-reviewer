export interface CommitFacts {
  parents: string[];
  authorEmail: string;
  message: string;
}

function subject(message: string): string {
  return message.split('\n', 1)[0].trim();
}

/**
 * Whether a branch head is this round's own fix: authored under our identity, or committed directly
 * on the audited head with the plan's subject line. The second arm exists because the identity alone
 * once failed — PR #32's fixer committed as `Claude <noreply@anthropic.com>`, and the fix it pushed
 * was then taken for somebody else's commit.
 */
export function isOwnFix(
  commit: CommitFacts,
  round: { headSha: string; plan: { commitMessage: string } | null },
  ourEmail: string | null,
): boolean {
  if (ourEmail && commit.authorEmail === ourEmail) return true;
  return (
    round.plan !== null &&
    commit.parents.length === 1 &&
    commit.parents[0] === round.headSha &&
    subject(commit.message) === subject(round.plan.commitMessage)
  );
}
