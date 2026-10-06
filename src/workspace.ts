import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where reviewed repositories are checked out. Default (a laptop) keeps them under the project, but
 * on a runner the project IS the action's install tree — the reviewed repo would sit beneath the
 * reviewer's own node_modules and git config, where one of its scripts could rewrite the live
 * credential helper, and where its test suite resolves modules by walking up into ours.
 */
function workspaceRoot(): string {
  const configured = process.env.REVIEWER_WORKSPACE_ROOT?.trim();
  return configured ? configured : path.join(projectRoot, 'workspaces');
}

export function workspacePath(repoSlug: string): string {
  return path.join(workspaceRoot(), repoSlug.replace('/', '__'));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** Clone once, then fetch + checkout the PR branch hard-reset to the given SHA. */
export async function prepareWorkspace(
  repoSlug: string,
  cloneUrl: string,
  branch: string,
  headSha: string,
): Promise<string> {
  const dir = workspacePath(repoSlug);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await execFileAsync('git', ['clone', cloneUrl, dir]);
  }
  await git(dir, ['fetch', 'origin', '--prune']);
  await git(dir, ['checkout', '-B', branch, headSha]);
  await git(dir, ['reset', '--hard', headSha]);
  await git(dir, ['clean', '-fd']);
  await ensureCommitIdentity(dir);
  return dir;
}

/**
 * The fixer commits, and `git commit` with no configured identity fails — on a fresh CI
 * runner there is no global one. Left alone that surfaces an hour into a round, after the
 * fix has already been written, as a git error nobody reads. Set the identity from the
 * environment when it is provided, and refuse the workspace now if there is still none.
 */
async function ensureCommitIdentity(dir: string): Promise<void> {
  const name = process.env.REVIEWER_GIT_NAME;
  const email = process.env.REVIEWER_GIT_EMAIL;
  if (name) await git(dir, ['config', 'user.name', name]);
  if (email) await git(dir, ['config', 'user.email', email]);
  try {
    await git(dir, ['config', '--get', 'user.email']);
  } catch {
    throw new Error(
      'no git commit identity in this workspace — set REVIEWER_GIT_NAME and REVIEWER_GIT_EMAIL ' +
        '(or a global git user.email) so the fixer can commit',
    );
  }
}

export async function remoteBranchSha(dir: string, branch: string): Promise<string> {
  await git(dir, ['fetch', 'origin', '--prune']);
  return git(dir, ['rev-parse', `origin/${branch}`]);
}

/** File paths touched between two commits (base...head). */
export async function changedFilePaths(dir: string, baseSha: string, headSha: string): Promise<string[]> {
  const out = await git(dir, ['diff', '--name-only', `${baseSha}...${headSha}`]);
  return out === '' ? [] : out.split('\n').filter((l) => l.trim() !== '');
}

export interface CommandResult {
  passed: boolean;
  trimmedOutput: string | null;
}

/**
 * Variables that belong to the reviewer and must never reach the reviewed repo's own commands.
 * `npm ci` executes that repo's install scripts and its test suite is arbitrary code; neither
 * has any business holding the App private key that can push to it, the credential that pays
 * for the review, or a connection string to the reviewer's own database. The last one is not
 * hypothetical: a repo whose tests read `DATABASE_URL` would point them at the reviewer's
 * database, and only a `_test`-suffix guard in the repo under review stopped exactly that.
 *
 * Everything the reviewer sets for itself is `REVIEWER_`-prefixed, which `repoCommandEnv`
 * strips wholesale; these are the ones that cannot be renamed because another tool defines them.
 */
const REVIEWER_ONLY_ENV = [
  'DATABASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

/**
 * Variables the reviewed repo's own commands need, carried as newline-separated KEY=VALUE lines
 * (a database URL for its test suite, say). They arrive in ONE variable and are applied only to
 * the child's environment — never exported into the reviewer's own process, which is what the
 * first version of this did: a repo could then name `DATABASE_URL` or any `REVIEWER_*` variable
 * and repoint the reviewer at a database of its choosing.
 */
const REPO_ENV_CARRIER = 'REVIEWER_REPO_ENV';

/** The environment a reviewed repo's own command gets: ours, minus anything that is ours. */
export function repoCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, CI: 'true' };
  for (const key of REVIEWER_ONLY_ENV) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith('REVIEWER_')) delete env[key];

  // Applied last, so a repo CAN legitimately set a name on the strip list for its own commands —
  // which is the point — without that name ever having existed in the reviewer's environment.
  for (const line of (source[REPO_ENV_CARRIER] ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) {
      console.warn(`ignoring malformed repo-env line: ${trimmed.slice(0, 40)}`);
      continue;
    }
    env[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return env;
}

/** Run a repo command (setup or tests); returns pass/fail with trimmed output on failure. */
export async function runRepoCommand(
  dir: string,
  command: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<CommandResult> {
  try {
    await execFileAsync('sh', ['-c', command], {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: repoCommandEnv(),
    });
    return { passed: true, trimmedOutput: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout ?? '', e.stderr ?? ''].join('\n');
    return { passed: false, trimmedOutput: trimOutput(combined || (e.message ?? 'unknown error')) };
  }
}

/** Keep the failure-relevant tail; full logs don't belong in the database or prompts. */
function trimOutput(output: string): string {
  // NUL can show up in test failure diffs (repos that use '\u0000' key separators) and
  // Postgres jsonb/text columns reject it — store the literal escape text instead.
  const lines = output.replaceAll('\u0000', '\\u0000').split('\n').filter((l) => l.trim() !== '');
  const interesting = lines.filter(
    (l) => /fail|error|✗|✘|×|assert|expect|Δ|throw/i.test(l) && !/^npm (warn|notice)/i.test(l),
  );
  const chosen = interesting.length > 0 ? interesting.slice(0, 60) : lines.slice(-40);
  return chosen.join('\n').slice(0, 8000);
}
