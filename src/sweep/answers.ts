import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { listIssueComments } from '../github.js';
import { ANSWER_AUTHORITY, answersFromReply } from '../stages/answers.js';
import type { QuestionRow } from '../stages/questions.js';
import { requireRound, type SweepCtx } from '../stages/context.js';

/**
 * Read the owner's replies to the questions a sweep asked. Each question lives in its concern's
 * issue, numbered there, so the thread of that issue is where its answer arrives. Answers become
 * repo policy exactly as in a PR review. Nothing waits on them: an unanswered question keeps the
 * `needs-answer` label on the issue, and that is all.
 */
export async function collectIssueAnswers(ctx: SweepCtx): Promise<number> {
  const round = requireRound(ctx);
  const rows = await db
    .select({ question: schema.questions, issueNumber: schema.concerns.issueNumber })
    .from(schema.questions)
    .innerJoin(schema.concerns, eq(schema.questions.concernId, schema.concerns.id))
    .where(
      and(
        eq(schema.concerns.repoId, ctx.repo.id),
        eq(schema.concerns.status, 'open'),
        isNotNull(schema.questions.sweepId),
        eq(schema.questions.userFacing, true),
        isNull(schema.questions.answeredAt),
        isNotNull(schema.concerns.issueNumber),
      ),
    );
  if (rows.length === 0) return 0;

  const byIssue = new Map<number, QuestionRow[]>();
  for (const r of rows) {
    const list = byIssue.get(r.issueNumber!) ?? [];
    list.push(r.question);
    byIssue.set(r.issueNumber!, list);
  }

  let answered = 0;
  for (const [issueNumber, pending] of byIssue) {
    const concernId = pending[0].concernId!;
    // Comments already banked as an answer to one of this concern's questions are not read again.
    const used = new Set(
      (
        await db
          .select({ id: schema.questions.sourceCommentId })
          .from(schema.questions)
          .where(and(eq(schema.questions.concernId, concernId), isNotNull(schema.questions.sourceCommentId)))
      ).map((r) => Number(r.id)),
    );
    let comments;
    try {
      comments = await listIssueComments(ctx.repo.slug, issueNumber);
    } catch (err) {
      console.warn(`could not read comments on #${issueNumber} (${String(err).split('\n')[0]}) — skipped`);
      continue;
    }
    const open = new Map(pending.sort((a, b) => a.ordinal - b.ordinal).map((q) => [q.ordinal, q]));
    for (const comment of comments) {
      if (open.size === 0) break;
      if (used.has(comment.id)) continue;
      if (!ANSWER_AUTHORITY.has(comment.authorAssociation)) continue;
      const answers = await answersFromReply(round.id, comment, [...open.values()]);
      if (!answers) continue;
      for (const [ordinal, answer] of answers) {
        const q = open.get(ordinal);
        if (!q) continue;
        await db.transaction(async (tx) => {
          await tx
            .update(schema.questions)
            .set({ answer, answeredAt: new Date(), sourceCommentId: comment.id })
            .where(eq(schema.questions.id, q.id));
          await tx.insert(schema.policies).values({ repoId: ctx.repo.id, question: q.text, answer });
        });
        open.delete(ordinal);
        answered++;
      }
      console.log(`  #${issueNumber}: reply ${comment.id} from ${comment.authorLogin} answered ${answers.size} question(s)`);
    }
  }
  return answered;
}
