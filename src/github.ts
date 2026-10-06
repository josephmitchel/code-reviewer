import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appAuthConfigured, installationToken } from './gh-auth.js';

const execFileAsync = promisify(execFile);

/**
 * Every call re-checks the token rather than capturing one at startup: in CI the credential is
 * an App installation token that expires inside the length of a single round. Locally there are
 * no App credentials and `gh` uses its own login, exactly as before.
 */
async function gh(args: string[]): Promise<string> {
  const env = appAuthConfigured()
    ? { ...process.env, GH_TOKEN: await installationToken() }
    : process.env;
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 32 * 1024 * 1024, env });
  return stdout;
}

async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}

export interface PrInfo {
  headSha: string;
  baseSha: string;
  headRef: string;
  isFork: boolean;
  isDraft: boolean;
  state: string;
  changedFiles: string[];
}

export async function getPr(repoSlug: string, prNumber: number): Promise<PrInfo> {
  const pr = await ghJson<{
    head: { sha: string; ref: string; repo: { full_name: string } | null };
    base: { sha: string };
    state: string;
    draft?: boolean;
  }>(['api', `repos/${repoSlug}/pulls/${prNumber}`]);
  const files = await ghJson<Array<{ filename: string }>>([
    'api',
    `repos/${repoSlug}/pulls/${prNumber}/files`,
    '--paginate',
  ]);
  return {
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    isFork: pr.head.repo === null || pr.head.repo.full_name !== repoSlug,
    isDraft: pr.draft === true,
    state: pr.state,
    changedFiles: files.map((f) => f.filename),
  };
}

export async function postComment(
  repoSlug: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const res = await ghJson<{ id: number }>([
    'api',
    `repos/${repoSlug}/issues/${prNumber}/comments`,
    '-f',
    `body=${body}`,
  ]);
  return res.id;
}

export async function updateComment(
  repoSlug: string,
  commentId: number,
  body: string,
): Promise<void> {
  await gh([
    'api',
    '-X',
    'PATCH',
    `repos/${repoSlug}/issues/comments/${commentId}`,
    '-f',
    `body=${body}`,
  ]);
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  authorLogin: string;
  /**
   * GitHub's relationship between this author and the repo: OWNER, MEMBER, COLLABORATOR,
   * CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, … Carried because a reply is an instruction to the
   * reviewer — it decides what gets fixed and becomes repo policy — so who wrote it matters.
   */
  authorAssociation: string;
}

export async function getCommentCreatedAt(repoSlug: string, commentId: number): Promise<string> {
  const c = await ghJson<{ created_at: string }>([
    'api',
    `repos/${repoSlug}/issues/comments/${commentId}`,
  ]);
  return c.created_at;
}

/** Replies can arrive as plain issue comments or via the "Review changes" flow (PR reviews) — read both. */
export async function listRepliesSince(
  repoSlug: string,
  prNumber: number,
  sinceIso: string,
  excludeCommentId: number,
): Promise<IssueComment[]> {
  const since = new Date(sinceIso).getTime();
  const comments = await ghJson<
    Array<{ id: number; body: string; created_at: string; user: { login: string }; author_association?: string }>
  >(['api', `repos/${repoSlug}/issues/${prNumber}/comments`, '--paginate']);
  const reviews = await ghJson<
    Array<{
      id: number;
      body: string | null;
      submitted_at?: string;
      state: string;
      user: { login: string };
      author_association?: string;
    }>
  >(['api', `repos/${repoSlug}/pulls/${prNumber}/reviews`, '--paginate']);
  const all: IssueComment[] = [
    ...comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      authorLogin: c.user.login,
      // Absent is treated as NONE, never as trusted.
      authorAssociation: c.author_association ?? 'NONE',
    })),
    ...reviews
      .filter((r) => r.state !== 'PENDING' && r.body && r.submitted_at)
      .map((r) => ({
        id: r.id,
        body: r.body as string,
        createdAt: r.submitted_at as string,
        authorLogin: r.user.login,
        authorAssociation: r.author_association ?? 'NONE',
      })),
  ];
  return all
    .filter((c) => c.id !== excludeCommentId && new Date(c.createdAt).getTime() > since)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function postStatus(
  repoSlug: string,
  sha: string,
  state: 'success' | 'failure' | 'pending',
  description: string,
): Promise<void> {
  await gh([
    'api',
    `repos/${repoSlug}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=code-reviewer/gate',
    '-f',
    `description=${description.slice(0, 140)}`,
  ]);
}

export async function hasGateStatus(repoSlug: string, sha: string): Promise<boolean> {
  const statuses = await ghJson<Array<{ context: string; state: string }>>([
    'api',
    `repos/${repoSlug}/commits/${sha}/statuses`,
  ]);
  return statuses.some((s) => s.context === 'code-reviewer/gate' && s.state === 'success');
}

/** Open PR numbers, oldest first — what the sweep reconciles the database against. */
export async function listOpenPrNumbers(repoSlug: string): Promise<number[]> {
  const prs = await ghJson<Array<{ number: number }>>([
    'pr', 'list', '-R', repoSlug, '--state', 'open', '--json', 'number', '--limit', '100',
  ]);
  return prs.map((p) => p.number).sort((a, b) => a - b);
}

/** The repo's default branch — the ref a dispatch has to name, and not always `main`. */
export async function getDefaultBranch(repoSlug: string): Promise<string> {
  return (await ghJson<{ default_branch: string }>(['api', `repos/${repoSlug}`])).default_branch;
}

/**
 * Fire a `workflow_dispatch` so the next queued review starts at once instead of waiting for
 * the scheduled sweep. Dispatches are the one event type GitHub still delivers when the actor
 * is a token it would otherwise suppress, so this chain cannot be broken by loop protection.
 */
export async function dispatchWorkflow(repoSlug: string, workflowFile: string, ref: string): Promise<void> {
  await gh([
    'api',
    '-X',
    'POST',
    `repos/${repoSlug}/actions/workflows/${workflowFile}/dispatches`,
    '-f',
    `ref=${ref}`,
  ]);
}

export async function getViewerLogin(): Promise<string> {
  const res = await ghJson<{ login: string }>(['api', 'user']);
  return res.login;
}
