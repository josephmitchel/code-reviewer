import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { coveredCommits, type PassedReview } from '../gate-coverage.js';
import { getPr, getTreeSha, hasGateStatus, postComment, postStatus } from '../github.js';

export type CarryOutcome = 'carried' | 'gated' | 'nothing';

/**
 * A passed review gates one commit and never re-gates a moved head. That blocked PR #32 when PR #33,
 * stacked on it, was merged into its branch: the merge commit held exactly the code of #33's gated
 * head, and nothing gated it. So a head whose tree equals a covered commit (see coveredCommits) gets
 * that gate carried to it. Only identical code qualifies; anything else needs a review of its own.
 */
export async function carryGate(slug: string, prNumber: number): Promise<CarryOutcome> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) throw new Error(`repo ${slug} not registered`);
  const passed = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.state, 'passed')));
  const own = passed.find((r) => r.prNumber === prNumber);
  if (!own) {
    console.log(`#${prNumber} has no passed review — no gate to carry`);
    return 'nothing';
  }

  const pr = await getPr(slug, prNumber);
  if (await hasGateStatus(slug, pr.headSha)) {
    console.log(`#${prNumber}'s head ${pr.headSha.slice(0, 10)} is already gated`);
    return 'gated';
  }

  const ids = passed.map((r) => r.id);
  const statuses = await db
    .select()
    .from(schema.githubArtifacts)
    .where(and(inArray(schema.githubArtifacts.reviewId, ids), eq(schema.githubArtifacts.kind, 'commit_status')));
  const rounds = await db
    .select({ reviewId: schema.rounds.reviewId, roundNo: schema.rounds.roundNo, kind: schema.rounds.kind, baseSha: schema.rounds.baseSha })
    .from(schema.rounds)
    .where(inArray(schema.rounds.reviewId, ids));
  const reviews: PassedReview[] = passed.map((r) => ({
    id: r.id,
    lastFullBase:
      rounds
        .filter((ro) => ro.reviewId === r.id && ro.kind === 'full')
        .sort((a, b) => b.roundNo - a.roundNo)[0]?.baseSha ?? null,
    gated: statuses
      .filter((s) => s.reviewId === r.id && s.sha && (s.payload as { state?: string } | null)?.state === 'success')
      .map((s) => s.sha!),
  }));

  const headTree = await getTreeSha(slug, pr.headSha);
  for (const sha of coveredCommits(own.id, reviews)) {
    if ((await getTreeSha(slug, sha)) !== headTree) continue;
    await postStatus(slug, pr.headSha, 'success', `carried from ${sha.slice(0, 10)}: the same code, already reviewed`);
    await db.insert(schema.githubArtifacts).values({
      reviewId: own.id,
      kind: 'commit_status',
      sha: pr.headSha,
      payload: { state: 'success', carriedFrom: sha },
    });
    const commentId = await postComment(
      slug,
      prNumber,
      `**Gate carried** to \`${pr.headSha.slice(0, 10)}\`: it holds exactly the code of ` +
        `\`${sha.slice(0, 10)}\`, which already passed review, so nothing new needs reviewing.`,
    );
    await db.insert(schema.githubArtifacts).values({
      reviewId: own.id,
      kind: 'carry_comment',
      githubId: String(commentId),
      sha: pr.headSha,
    });
    console.log(`gate carried to ${pr.headSha.slice(0, 10)} from ${sha.slice(0, 10)}`);
    return 'carried';
  }
  console.log(
    `#${prNumber}'s head ${pr.headSha.slice(0, 10)} matches no reviewed commit — it needs a review of its own`,
  );
  return 'nothing';
}
