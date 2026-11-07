import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitFacts } from './fix-commit.js';
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

/** A commit's parents, author and message, read without a checkout. */
export async function getCommit(repoSlug: string, sha: string): Promise<CommitFacts> {
  const c = await ghJson<{
    parents: Array<{ sha: string }>;
    author: { email: string } | null;
    message: string;
  }>(['api', `repos/${repoSlug}/git/commits/${sha}`]);
  return { parents: c.parents.map((p) => p.sha), authorEmail: c.author?.email ?? '', message: c.message };
}

/** A commit's tree: two commits with the same tree hold exactly the same code. */
export async function getTreeSha(repoSlug: string, sha: string): Promise<string> {
  return (await ghJson<{ tree: { sha: string } }>(['api', `repos/${repoSlug}/git/commits/${sha}`])).tree.sha;
}

/** The Actions run this process belongs to, or null outside CI. */
export function actionsRunUrl(): string | null {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null;
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

// ---------------------------------------------------------------------------------------------
// Issues — the nightly sweep's output. A concern is an issue; the owner closing it asks for a
// judge; the two long-lived issues per repo (digest, status) are edited in place every night.
// Everything goes through `gh api` form fields (`-f`), which is how the PR comments above have
// always been posted: a value is one argument however many lines it holds, and `name[]=` repeats
// build an array.
// ---------------------------------------------------------------------------------------------

/** The commit at the tip of a branch, read without a checkout. */
export async function getBranchHead(repoSlug: string, branch: string): Promise<string> {
  const b = await ghJson<{ commit: { sha: string } }>(['api', `repos/${repoSlug}/branches/${branch}`]);
  return b.commit.sha;
}

/** How many commits `base...head` spans, from the compare API (no checkout needed). */
export async function compareCommitCount(repoSlug: string, baseSha: string, headSha: string): Promise<number> {
  const c = await ghJson<{ total_commits: number }>(['api', `repos/${repoSlug}/compare/${baseSha}...${headSha}`]);
  return c.total_commits;
}

export interface IssueInfo {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  /** GitHub's close reason: `completed` (fixed) or `not_planned` (dismissed). Null while open. */
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
}

interface RawIssue {
  number: number;
  node_id: string;
  state: string;
  state_reason?: string | null;
  title: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  created_at: string;
  closed_at: string | null;
}

function toIssueInfo(i: RawIssue): IssueInfo {
  return {
    number: i.number,
    nodeId: i.node_id,
    state: i.state === 'closed' ? 'closed' : 'open',
    stateReason: (i.state_reason as IssueInfo['stateReason']) ?? null,
    title: i.title,
    body: i.body ?? '',
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    createdAt: i.created_at,
    closedAt: i.closed_at,
  };
}

/** Open issues carrying a label, oldest first. Pull requests share the endpoint and are dropped. */
export async function listOpenIssuesByLabel(repoSlug: string, label: string): Promise<IssueInfo[]> {
  const rows = await ghJson<Array<RawIssue & { pull_request?: unknown }>>([
    'api',
    `repos/${repoSlug}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    '--paginate',
  ]);
  return rows
    .filter((r) => r.pull_request === undefined || r.pull_request === null)
    .map(toIssueInfo)
    .sort((a, b) => a.number - b.number);
}

export async function getIssue(repoSlug: string, number: number): Promise<IssueInfo> {
  return toIssueInfo(await ghJson<RawIssue>(['api', `repos/${repoSlug}/issues/${number}`]));
}

export async function createIssue(
  repoSlug: string,
  input: { title: string; body: string; labels: string[] },
): Promise<IssueInfo> {
  const args = ['api', '-X', 'POST', `repos/${repoSlug}/issues`, '-f', `title=${input.title}`, '-f', `body=${input.body}`];
  for (const label of input.labels) args.push('-f', `labels[]=${label}`);
  return toIssueInfo(await ghJson<RawIssue>(args));
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  /** Only meaningful with `state: 'closed'`. */
  stateReason?: 'completed' | 'not_planned';
  /** Replaces the whole label set. */
  labels?: string[];
}

export async function updateIssue(repoSlug: string, number: number, patch: IssuePatch): Promise<void> {
  // JSON on stdin rather than form fields: `labels: []` (take every label off) has no `-f` spelling,
  // and gh refuses to mix `--input` with `-f`, so the whole patch goes one way.
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.body !== undefined) body.body = patch.body;
  if (patch.state !== undefined) body.state = patch.state;
  if (patch.stateReason !== undefined) body.state_reason = patch.stateReason;
  if (patch.labels !== undefined) body.labels = patch.labels;
  await ghWithStdin(['api', '-X', 'PATCH', `repos/${repoSlug}/issues/${number}`, '--input', '-'], JSON.stringify(body));
}

export async function addIssueLabels(repoSlug: string, number: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  const args = ['api', '-X', 'POST', `repos/${repoSlug}/issues/${number}/labels`];
  for (const label of labels) args.push('-f', `labels[]=${label}`);
  await gh(args);
}

/** One GraphQL request. Variables go in as `-F`/`-f` fields; gh types numbers and booleans from `-F`. */
async function ghGraphql<T>(query: string, variables: Record<string, string | number | boolean>): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
  const res = await ghJson<{ data: T; errors?: Array<{ message: string }> }>(args);
  if (res.errors?.length) throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join('; ')}`);
  return res.data;
}

export interface IssueRelations {
  nodeId: string;
  state: 'OPEN' | 'CLOSED';
  /** Issues this one blocks. */
  blocking: Array<{ nodeId: string; number: number }>;
}

/** Dependencies only exist in GraphQL: the node id (what the mutations take) and what the issue blocks. */
export async function getIssueRelations(repoSlug: string, number: number): Promise<IssueRelations> {
  const [owner, name] = repoSlug.split('/');
  const data = await ghGraphql<{
    repository: { issue: { id: string; state: 'OPEN' | 'CLOSED'; blocking: { nodes: Array<{ id: string; number: number }> } } };
  }>(
    'query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ id state blocking(first:50){ nodes { id number } } } } }',
    { o: owner, r: name, n: number },
  );
  const issue = data.repository.issue;
  return { nodeId: issue.id, state: issue.state, blocking: issue.blocking.nodes.map((b) => ({ nodeId: b.id, number: b.number })) };
}

/**
 * Turn "dependent is blocked by blocker" into "dependent relates to blocker", in one request so the
 * relationship is never missing from the sidebar between the two steps.
 */
export async function swapBlockedByForRelatesTo(dependentNodeId: string, blockerNodeId: string): Promise<void> {
  await ghGraphql(
    'mutation($dep:ID!,$blocker:ID!){ removeBlockedBy(input:{issueId:$dep, blockingIssueId:$blocker}){ clientMutationId } addRelatesTo(input:{issueId:$dep, relatedIssueId:$blocker}){ clientMutationId } }',
    { dep: dependentNodeId, blocker: blockerNodeId },
  );
}

/**
 * Make sure a label exists before an issue asks for it: GitHub creates unknown labels on an issue
 * with a random colour, and a repo's label list is the owner's, so the sweep's labels are declared
 * once with a colour and a description instead. Existing labels are left exactly as they are.
 */
export async function ensureLabel(
  repoSlug: string,
  label: { name: string; color: string; description: string },
): Promise<void> {
  try {
    await gh([
      'api',
      '-X',
      'POST',
      `repos/${repoSlug}/labels`,
      '-f',
      `name=${label.name}`,
      '-f',
      `color=${label.color}`,
      '-f',
      `description=${label.description}`,
    ]);
  } catch (err) {
    if (!/422|already_exists/.test(String(err))) throw err;
  }
}

/** All comments on an issue, oldest first, with who wrote them and what GitHub says they are to the repo. */
export async function listIssueComments(repoSlug: string, number: number): Promise<IssueComment[]> {
  const comments = await ghJson<
    Array<{ id: number; body: string; created_at: string; user: { login: string }; author_association?: string }>
  >(['api', `repos/${repoSlug}/issues/${number}/comments`, '--paginate']);
  return comments
    .map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      authorLogin: c.user.login,
      authorAssociation: c.author_association ?? 'NONE',
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * The events on an issue that say what closed it: a `closed` event names the commit when a commit
 * message did it; a `cross-referenced` event names a PR that mentioned it, which is how a merged
 * PR with `fixes #N` shows up; a `referenced` event names a commit that mentioned it.
 */
export interface IssueTimelineEvent {
  event: string;
  createdAt: string | null;
  commitSha: string | null;
  /** For `cross-referenced`: the issue or PR that referenced this one. */
  source: { number: number; isPullRequest: boolean } | null;
}

export async function listIssueTimeline(repoSlug: string, number: number): Promise<IssueTimelineEvent[]> {
  const events = await ghJson<
    Array<{
      event: string;
      created_at?: string;
      commit_id?: string | null;
      source?: { issue?: { number: number; pull_request?: unknown } } | null;
    }>
  >(['api', `repos/${repoSlug}/issues/${number}/timeline`, '--paginate']);
  return events.map((e) => ({
    event: e.event,
    createdAt: e.created_at ?? null,
    commitSha: e.commit_id ?? null,
    source: e.source?.issue
      ? { number: e.source.issue.number, isPullRequest: e.source.issue.pull_request != null }
      : null,
  }));
}

export interface MergedPrFacts {
  number: number;
  title: string;
  body: string;
  merged: boolean;
  mergeCommitSha: string | null;
}

export async function getPrFacts(repoSlug: string, number: number): Promise<MergedPrFacts> {
  const pr = await ghJson<{
    number: number;
    title: string;
    body: string | null;
    merged: boolean;
    merge_commit_sha: string | null;
  }>(['api', `repos/${repoSlug}/pulls/${number}`]);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    merged: pr.merged,
    mergeCommitSha: pr.merged ? pr.merge_commit_sha : null,
  };
}

/**
 * Pin an issue to the top of the repo's issues page. GitHub allows three; a fourth is refused,
 * and so is pinning the same issue twice. Both are fine to ignore — the status page works unpinned.
 */
export async function pinIssue(issueNodeId: string): Promise<boolean> {
  try {
    await gh([
      'api',
      'graphql',
      '-f',
      'query=mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { id } } }',
      '-f',
      `id=${issueNodeId}`,
    ]);
    return true;
  } catch (err) {
    console.warn(`could not pin the issue (${String(err).split('\n')[0]})`);
    return false;
  }
}

/** `gh api --input -` with the request body on stdin, for the shapes form fields cannot express. */
async function ghWithStdin(args: string[], input: string): Promise<string> {
  const env = appAuthConfigured() ? { ...process.env, GH_TOKEN: await installationToken() } : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`gh exited ${code}: ${errOut}`))));
    child.stdin.end(input);
  });
}
