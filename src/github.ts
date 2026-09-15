import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 32 * 1024 * 1024 });
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
  state: string;
  changedFiles: string[];
}

export async function getPr(repoSlug: string, prNumber: number): Promise<PrInfo> {
  const pr = await ghJson<{
    head: { sha: string; ref: string; repo: { full_name: string } | null };
    base: { sha: string };
    state: string;
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
    Array<{ id: number; body: string; created_at: string; user: { login: string } }>
  >(['api', `repos/${repoSlug}/issues/${prNumber}/comments`, '--paginate']);
  const reviews = await ghJson<
    Array<{ id: number; body: string | null; submitted_at?: string; state: string; user: { login: string } }>
  >(['api', `repos/${repoSlug}/pulls/${prNumber}/reviews`, '--paginate']);
  const all: IssueComment[] = [
    ...comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      authorLogin: c.user.login,
    })),
    ...reviews
      .filter((r) => r.state !== 'PENDING' && r.body && r.submitted_at)
      .map((r) => ({
        id: r.id,
        body: r.body as string,
        createdAt: r.submitted_at as string,
        authorLogin: r.user.login,
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

export async function getViewerLogin(): Promise<string> {
  const res = await ghJson<{ login: string }>(['api', 'user']);
  return res.login;
}
