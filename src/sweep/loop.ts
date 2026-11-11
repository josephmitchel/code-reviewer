import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { SweepSummary } from '../db/schema.js';
import { compareCommitCount, getBranchHead, getDefaultBranch } from '../github.js';
import { markStage } from '../heartbeat.js';
import { changedFilePaths, prepareWorkspace, runRepoCommand } from '../workspace.js';
import { auditRound } from '../stages/audit.js';
import { synthesizeRound } from '../stages/synthesis.js';
import { requireRound, type RepoRow, type SweepCtx, type SweepRow } from '../stages/context.js';
import { settleOwnerDecisions } from './judge.js';
import { collectIssueAnswers } from './answers.js';
import { publishIssues } from './publish.js';
import { judgeTickets } from './tickets.js';

type State = (typeof schema.sweepState.enumValues)[number];
type Partial = Pick<SweepSummary, 'judged' | 'answered' | 'commits' | 'tickets'>;

/**
 * One night's sweep of a repo:
 *
 *   intake → judging → answering → auditing → synthesizing → judging_tickets → publishing → done
 *
 * Apply the owner's decisions first (`wontfix` dismissals, hand-closed concerns, ticked minors), so
 * a dismissed point is policy before the audit runs. Audit the default branch's diff since the
 * previous sweep; an empty diff skips the audit but still settles, collects answers and republishes.
 * Every ticket labelled `needs-judging` — the reviewer's own concerns included — is judged after
 * synthesis, so that judge sees what the audit found in it. Nothing is fixed and nothing is gated:
 * the output is GitHub issues. State lives in Postgres, so a killed run resumes where it stopped.
 */
export async function runSweep(repoSlug: string): Promise<'swept' | 'failed'> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, repoSlug));
  if (!repo) throw new Error(`repo ${repoSlug} not registered — run: code-reviewer repo add ${repoSlug} …`);

  const ctx: SweepCtx = { repo, sweep: await loadOrCreateSweep(repo), round: null, workspaceDir: null };
  if (ctx.sweep.currentRoundId) {
    [ctx.round] = await db.select().from(schema.rounds).where(eq(schema.rounds.id, ctx.sweep.currentRoundId));
  }
  markStage(ctx.sweep.state);

  if (ctx.sweep.state === 'failed') {
    const retry = inferRetryState(ctx);
    console.log(`previous sweep failed (${ctx.sweep.error ?? 'no error recorded'}) — retrying from ${retry}`);
    await setState(ctx, retry);
  }

  let partial: Partial = {
    judged: ctx.sweep.summary?.judged ?? [],
    answered: ctx.sweep.summary?.answered ?? 0,
    commits: ctx.sweep.summary?.commits ?? 0,
    tickets: ctx.sweep.summary?.tickets ?? [],
  };

  while (ctx.sweep.state !== 'done') {
    try {
      if (!ctx.workspaceDir && ctx.sweep.state !== 'pending' && ctx.sweep.state !== 'intake') {
        await prepareSweepWorkspace(ctx);
      }
      switch (ctx.sweep.state) {
        case 'pending':
          await setState(ctx, 'intake');
          break;
        case 'intake':
          partial = { ...partial, commits: await runSweepIntake(ctx) };
          await setState(ctx, 'judging');
          break;
        case 'judging': {
          const { judged, tickets } = await settleOwnerDecisions(ctx);
          partial = { ...partial, judged, tickets };
          await savePartial(ctx, partial);
          console.log(`settled ${judged.length} concern(s) and ${tickets.length} ticket(s) the owner decided on`);
          await setState(ctx, 'answering');
          break;
        }
        case 'answering': {
          const answered = await collectIssueAnswers(ctx);
          partial = { ...partial, answered };
          await savePartial(ctx, partial);
          console.log(`recorded ${answered} answer(s)`);
          await setState(ctx, 'auditing');
          break;
        }
        case 'auditing': {
          const round = requireRound(ctx);
          if (round.baseSha === round.headSha) {
            console.log('nothing landed since the last sweep — skipping the audit');
          } else {
            await auditRound(ctx, {
              mode: 'sweep',
              changedFiles: () => changedFilePaths(ctx.workspaceDir!, round.baseSha, round.headSha),
            });
          }
          await setState(ctx, 'synthesizing');
          break;
        }
        case 'synthesizing': {
          const round = requireRound(ctx);
          if (round.baseSha !== round.headSha) {
            await synthesizeRound(ctx, { mode: 'sweep', origin: { sweepId: ctx.sweep.id } });
          }
          await setState(ctx, 'judging_tickets');
          break;
        }
        case 'judging_tickets': {
          const tickets = [...(partial.tickets ?? []).filter((t) => t.verdict === 'dismissed'), ...(await judgeTickets(ctx))];
          partial = { ...partial, tickets };
          await savePartial(ctx, partial);
          console.log(`judged ${tickets.length} ticket(s)`);
          await setState(ctx, 'publishing');
          break;
        }
        case 'publishing': {
          const summary = await publishIssues(ctx, partial);
          console.log(
            `published: ${summary.opened.length} opened, ${summary.closedByAudit.length} closed by the audit`,
          );
          await db
            .update(schema.sweeps)
            .set({ state: 'done', finishedAt: new Date(), updatedAt: new Date(), error: null })
            .where(eq(schema.sweeps.id, ctx.sweep.id));
          ctx.sweep = { ...ctx.sweep, state: 'done', error: null };
          markStage('done');
          if (ctx.round?.roundSummary) console.log(`\n${ctx.round.roundSummary.trim()}`);
          break;
        }
        default:
          throw new Error(`unhandled sweep state ${ctx.sweep.state}`);
      }
    } catch (err) {
      // The job fails with it, so GitHub's failed-run notification is what tells the owner.
      await setState(ctx, 'failed', String(err));
      throw err;
    }
  }
  console.log(`\nsweep ${ctx.sweep.id} done for ${repoSlug}`);
  return 'swept';
}

async function setState(ctx: SweepCtx, state: State, error: string | null = null): Promise<void> {
  await db
    .update(schema.sweeps)
    .set({ state, error, updatedAt: new Date() })
    .where(eq(schema.sweeps.id, ctx.sweep.id));
  ctx.sweep = { ...ctx.sweep, state, error };
  markStage(state);
  console.log(`\n=== sweep state: ${state} ===`);
}

async function savePartial(ctx: SweepCtx, partial: Partial): Promise<void> {
  const summary: SweepSummary = { opened: [], closedByAudit: [], ...ctx.sweep.summary, ...partial };
  await db.update(schema.sweeps).set({ summary, updatedAt: new Date() }).where(eq(schema.sweeps.id, ctx.sweep.id));
  ctx.sweep = { ...ctx.sweep, summary };
}

/**
 * The latest sweep if it has not finished (a killed or failed run resumes), otherwise a new one
 * whose base is the previous sweep's head. The very first sweep of a repo has no previous head,
 * so its base is the branch as it stands: it sets up the issues and audits nothing, and the
 * repo's history before tonight is never dumped on the owner.
 */
async function loadOrCreateSweep(repo: RepoRow): Promise<SweepRow> {
  const [latest] = await db
    .select()
    .from(schema.sweeps)
    .where(eq(schema.sweeps.repoId, repo.id))
    .orderBy(desc(schema.sweeps.id))
    .limit(1);
  if (latest && latest.state !== 'done') {
    console.log(`resuming sweep ${latest.id} for ${repo.slug} in state ${latest.state}`);
    return latest;
  }

  // Asked rather than trusted: the column defaults to `main` and nothing else maintains it.
  const branch = await getDefaultBranch(repo.slug);
  if (branch !== repo.defaultBranch) {
    await db.update(schema.repos).set({ defaultBranch: branch }).where(eq(schema.repos.id, repo.id));
  }
  const baseSha = latest?.headSha ?? (await getBranchHead(repo.slug, branch));
  const [sweep] = await db
    .insert(schema.sweeps)
    .values({ repoId: repo.id, branch, baseSha, state: 'pending' })
    .returning();
  console.log(
    `sweep ${sweep.id} created for ${repo.slug} (${branch} from ${baseSha.slice(0, 10)}` +
      `${latest ? '' : ', first sweep: nothing before tonight is audited'})`,
  );
  return sweep;
}

/** Read the branch head once, make the round, check the code out, run the suites if there is a diff. */
async function runSweepIntake(ctx: SweepCtx): Promise<number> {
  let sweep = ctx.sweep;
  if (!sweep.headSha) {
    // Fixed on first intake: a resumed sweep keeps auditing the head it started on, and whatever
    // landed meanwhile is the next sweep's.
    const headSha = await getBranchHead(ctx.repo.slug, sweep.branch);
    await db.update(schema.sweeps).set({ headSha, updatedAt: new Date() }).where(eq(schema.sweeps.id, sweep.id));
    sweep = { ...sweep, headSha };
    ctx.sweep = sweep;
  }
  const headSha = sweep.headSha!;

  let round = ctx.round;
  if (!round) {
    [round] = await db
      .insert(schema.rounds)
      .values({ sweepId: sweep.id, roundNo: 1, kind: 'full', headSha, baseSha: sweep.baseSha })
      .returning();
    await db
      .update(schema.sweeps)
      .set({ currentRoundId: round.id, updatedAt: new Date() })
      .where(eq(schema.sweeps.id, sweep.id));
    ctx.round = round;
    console.log(`round created: ${sweep.baseSha.slice(0, 10)}...${headSha.slice(0, 10)}`);
  }

  await prepareSweepWorkspace(ctx);

  let commits = 0;
  if (sweep.baseSha !== headSha) {
    commits = await compareCommitCount(ctx.repo.slug, sweep.baseSha, headSha).catch((err) => {
      console.warn(`could not count the commits (${String(err).split('\n')[0]})`);
      return 0;
    });
    console.log(`${commits} commit(s) landed since the last sweep`);
    if (!round.testResults) {
      const results = [];
      for (const tc of ctx.repo.testCommands) {
        console.log(`running tests: ${tc.name} (${tc.command})`);
        const res = await runRepoCommand(ctx.workspaceDir!, tc.command);
        results.push({
          name: tc.name,
          command: tc.command,
          passed: res.passed,
          ranAt: new Date().toISOString(),
          trimmedOutput: res.trimmedOutput,
          timedOut: res.timedOut,
        });
        console.log(`  ${tc.name}: ${res.passed ? 'pass' : res.timedOut ? 'TIMED OUT' : 'FAIL'}`);
      }
      await db.update(schema.rounds).set({ testResults: results }).where(eq(schema.rounds.id, round.id));
      ctx.round = { ...round, testResults: results };
    }
  }
  return commits;
}

/** Check the branch out at the sweep head and run the repo's setup, so judges and auditors have a working tree. */
async function prepareSweepWorkspace(ctx: SweepCtx): Promise<void> {
  const headSha = ctx.sweep.headSha;
  if (!headSha) throw new Error(`sweep ${ctx.sweep.id} in state ${ctx.sweep.state} has no head`);
  ctx.workspaceDir = await prepareWorkspace(ctx.repo.slug, ctx.repo.cloneUrl, ctx.sweep.branch, headSha);
  console.log(`workspace ready at ${ctx.workspaceDir}`);
  if (ctx.repo.setupCommand) {
    console.log(`running setup: ${ctx.repo.setupCommand}`);
    const setup = await runRepoCommand(ctx.workspaceDir, ctx.repo.setupCommand);
    if (!setup.passed) throw new Error(`setup command failed:\n${setup.trimmedOutput}`);
  }
}

/**
 * Where a failed sweep picks up. Every stage is safe to repeat — a dismissed ticket is closed and
 * no longer listed, auditors reuse their recorded sessions, answers skip comments already banked,
 * a judged ticket no longer carries the label, publishing changes only what differs — so this only
 * has to avoid redoing the expensive audit once it has been synthesized.
 */
export function inferRetryState(ctx: Pick<SweepCtx, 'round' | 'sweep'>): State {
  if (!ctx.round || !ctx.sweep.headSha) return 'intake';
  if (ctx.round.synthesizedAt) return 'judging_tickets';
  return 'judging';
}
