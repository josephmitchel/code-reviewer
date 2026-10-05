import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { db, pool, schema } from './db/client.js';
import { appAuthConfigured, configureAppAuth, installationToken } from './gh-auth.js';
import { dispatchWorkflow, getPr } from './github.js';
import { runReview } from './review-loop.js';

const USAGE = `code-reviewer — standalone multi-agent PR review service

Usage:
  code-reviewer run <owner/repo> <pr#> [--once] run (or resume) the review loop for a PR
      --once                                    return instead of waiting for answers or the
                                                review slot (for CI; prints the outcome)
  code-reviewer next <owner/repo>               print the PR number of the next queued review
  code-reviewer git-credential get              git credential helper (minted App token)
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
      const flags = rest.filter((a) => a.startsWith('--'));
      const [slug, pr] = rest.filter((a) => !a.startsWith('--'));
      if (!slug || !/^\d+$/.test(pr ?? '') || flags.some((f) => f !== '--once')) return usageExit();
      configureAppAuth(slug);
      const outcome = await runReview(slug, Number(pr), { oneShot: flags.includes('--once') });
      console.log(`outcome: ${outcome}`);
      // The slot just freed, so wake whatever was queued behind this review rather than making
      // it wait for the scheduled sweep. A review that threw is covered by the sweep instead.
      const dispatch = process.env.REVIEWER_DISPATCH_WORKFLOW;
      if (outcome === 'passed' && dispatch) await handOffToQueue(slug, dispatch);
      break;
    }
    case 'next': {
      const [slug] = rest;
      if (!slug) return usageExit();
      configureAppAuth(slug);
      await showNextQueued(slug);
      break;
    }
    case 'git-credential': {
      await gitCredential(rest[0] ?? '');
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

/**
 * git's credential helper protocol: git writes `key=value` lines on stdin and reads
 * `username=` / `password=` back on stdout. Only `get` for github.com is answered, and
 * `store`/`erase` are deliberately no-ops — nothing is persisted, which is the whole point:
 * each request mints or reuses a token that is still valid now.
 *
 * This is how the *fixer agent's* own `git push` authenticates. It runs that command itself,
 * at the end of a round that may have started before the current token existed, so there is
 * no command line we could have put a token on.
 */
async function gitCredential(operation: string): Promise<void> {
  // Anything but `get` has no answer, and an interactive invocation has no input to read.
  if (operation !== 'get' || process.stdin.isTTY) return;
  if (!appAuthConfigured()) return;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const fields = new Map(
    Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
      }),
  );
  // Staying silent for any other host lets git fall through to its normal helpers.
  if (fields.get('host') !== 'github.com') return;

  process.stdout.write(`username=x-access-token\npassword=${await installationToken()}\n`);
}

/**
 * Prints the PR number of the review that should run next, and nothing else — the Actions
 * workflow dispatches whatever lands on stdout, so every diagnostic goes to stderr.
 *
 * A review turned away by `claimReviewSlot` is left in `pending`, so that is the queue. It is
 * drained oldest first, and a queued PR that has since been closed is retired here rather
 * than costing a whole workflow run to discover it in intake.
 */
async function showNextQueued(slug: string): Promise<void> {
  const pr = await nextQueuedPr(slug);
  if (pr !== null) console.log(String(pr));
}

/** Dispatch the review workflow again so the queued PR starts now. */
async function handOffToQueue(slug: string, workflowFile: string): Promise<void> {
  const pr = await nextQueuedPr(slug);
  if (pr === null) return;
  const ref = process.env.REVIEWER_DISPATCH_REF ?? 'main';
  await dispatchWorkflow(slug, workflowFile, ref);
  console.log(`dispatched ${workflowFile} on ${ref} for queued PR #${pr}`);
}

async function nextQueuedPr(slug: string): Promise<number | null> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) throw new Error(`repo ${slug} not registered`);

  const active = await db
    .select({ pr: schema.reviews.prNumber, state: schema.reviews.state })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repoId, repo.id),
        notInArray(schema.reviews.state, ['passed', 'failed', 'pending']),
      ),
    );
  if (active.length > 0) {
    // Dispatching now would only queue again, and the holder dispatches on its way out.
    console.error(`PR #${active[0].pr} still holds the slot (${active[0].state}) — nothing to dispatch`);
    return null;
  }

  const queued = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.state, 'pending')))
    .orderBy(schema.reviews.createdAt);

  for (const review of queued) {
    let prState: string;
    try {
      prState = (await getPr(slug, review.prNumber)).state;
    } catch (err) {
      console.error(`could not check PR #${review.prNumber} (${String(err).split('\n')[0]}) — skipping`);
      continue;
    }
    if (prState === 'open') return review.prNumber;
    await db
      .update(schema.reviews)
      .set({ state: 'failed', error: `queued but PR is ${prState}`, updatedAt: new Date() })
      .where(eq(schema.reviews.id, review.id));
    console.error(`retired queued review for PR #${review.prNumber} (PR is ${prState})`);
  }
  console.error(`no queued review for ${slug}`);
  return null;
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
