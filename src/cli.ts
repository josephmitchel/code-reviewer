import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, pool, schema } from './db/client.js';
import { runReview } from './review-loop.js';

const USAGE = `code-reviewer — standalone multi-agent PR review service

Usage:
  code-reviewer run <owner/repo> <pr#>          run (or resume) the review loop for a PR
  code-reviewer repo add <owner/repo> [opts]    register a repo
      --setup <cmd>                             setup command (e.g. "npm ci")
      --tests <name=cmd>                        test suite (repeatable)
      --harness-notes-file <path>               per-repo notes for the testing auditor
      --redundancy <n>                          auditors per characteristic (default 1)
  code-reviewer repo set <owner/repo> [opts]    update repo config (same options)
  code-reviewer status [owner/repo]             show reviews and their states
  code-reviewer reset <owner/repo> <pr#>        delete a review's state (concerns/policies kept)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'run': {
      const [slug, pr] = rest;
      if (!slug || !/^\d+$/.test(pr ?? '')) return usageExit();
      await runReview(slug, Number(pr));
      break;
    }
    case 'repo': {
      const [sub, slug] = rest;
      if ((sub !== 'add' && sub !== 'set') || !slug) return usageExit();
      await repoUpsert(sub, slug, rest.slice(2));
      break;
    }
    case 'status':
      await showStatus(rest[0]);
      break;
    case 'reset': {
      const [slug, pr] = rest;
      if (!slug || !/^\d+$/.test(pr ?? '')) return usageExit();
      await resetReview(slug, Number(pr));
      break;
    }
    default:
      return usageExit();
  }
}

function usageExit(): never {
  console.error(USAGE);
  process.exit(2);
}

async function repoUpsert(mode: 'add' | 'set', slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      setup: { type: 'string' },
      tests: { type: 'string', multiple: true },
      'harness-notes-file': { type: 'string' },
      redundancy: { type: 'string' },
      'extra-context': { type: 'string' },
    },
  });

  const testCommands = (values.tests ?? []).map((t) => {
    const idx = t.indexOf('=');
    if (idx === -1) throw new Error(`--tests expects name=command, got: ${t}`);
    return { name: t.slice(0, idx), command: t.slice(idx + 1) };
  });
  const harnessNotes = values['harness-notes-file']
    ? fs.readFileSync(values['harness-notes-file'], 'utf8').trim()
    : undefined;

  const patch: Record<string, unknown> = {};
  if (values.setup !== undefined) patch.setupCommand = values.setup;
  if (testCommands.length > 0) patch.testCommands = testCommands;
  if (harnessNotes !== undefined) patch.harnessNotes = harnessNotes;
  if (values.redundancy !== undefined) patch.redundancy = Number(values.redundancy);
  if (values['extra-context'] !== undefined) patch.extraContext = values['extra-context'];

  const [existing] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (mode === 'add') {
    if (existing) throw new Error(`repo ${slug} already registered — use repo set`);
    await db.insert(schema.repos).values({
      slug,
      cloneUrl: `https://github.com/${slug}.git`,
      ...patch,
    });
    console.log(`registered ${slug}`);
  } else {
    if (!existing) throw new Error(`repo ${slug} not registered`);
    await db.update(schema.repos).set(patch).where(eq(schema.repos.id, existing.id));
    console.log(`updated ${slug}`);
  }
}

async function showStatus(slug?: string): Promise<void> {
  const repos = slug
    ? await db.select().from(schema.repos).where(eq(schema.repos.slug, slug))
    : await db.select().from(schema.repos);
  for (const repo of repos) {
    console.log(`\n${repo.slug} (tests: ${repo.testCommands.map((t) => t.name).join(', ') || 'none'})`);
    const reviews = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.repoId, repo.id))
      .orderBy(desc(schema.reviews.updatedAt));
    for (const r of reviews) {
      console.log(
        `  PR #${r.prNumber} [${r.state}] branch ${r.prBranch}${r.error ? ` — error: ${r.error.slice(0, 120)}` : ''}`,
      );
    }
    const open = await db.select().from(schema.concerns).where(eq(schema.concerns.repoId, repo.id));
    const openCount = open.filter((c) => c.status === 'open').length;
    console.log(`  concerns: ${openCount} open, ${open.length - openCount} resolved`);
  }
}

async function resetReview(slug: string, prNumber: number): Promise<void> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) throw new Error(`repo ${slug} not registered`);
  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.prNumber, prNumber)));
  if (!review) throw new Error(`no review for ${slug}#${prNumber}`);

  const rounds = await db.select().from(schema.rounds).where(eq(schema.rounds.reviewId, review.id));
  const roundIds = rounds.map((r) => r.id);
  await db.transaction(async (tx) => {
    for (const round of rounds) {
      await tx.delete(schema.findings).where(eq(schema.findings.roundId, round.id));
      await tx.delete(schema.agentSessions).where(eq(schema.agentSessions.roundId, round.id));
    }
    await tx.delete(schema.questions).where(eq(schema.questions.reviewId, review.id));
    await tx.delete(schema.githubArtifacts).where(eq(schema.githubArtifacts.reviewId, review.id));
    // Concerns and policies survive the reset; detach every reference they hold to the
    // review's rows (concerns from OTHER reviews can point at these rounds via lastSeenRoundId).
    if (roundIds.length > 0) {
      await tx
        .update(schema.concerns)
        .set({ lastSeenRoundId: null })
        .where(inArray(schema.concerns.lastSeenRoundId, roundIds));
    }
    await tx
      .update(schema.concerns)
      .set({ originReviewId: null })
      .where(eq(schema.concerns.originReviewId, review.id));
    await tx
      .update(schema.policies)
      .set({ sourceReviewId: null })
      .where(eq(schema.policies.sourceReviewId, review.id));
    await tx.delete(schema.rounds).where(eq(schema.rounds.reviewId, review.id));
    await tx.delete(schema.reviews).where(eq(schema.reviews.id, review.id));
  });
  console.log(`review for ${slug}#${prNumber} deleted (concerns and policies preserved)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
