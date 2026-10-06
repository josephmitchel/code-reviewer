import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { positiveIntEnv } from './stages/context.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The reviewer's own checkout. A tool-less agent still needs a working directory that exists, and
 * pointing it at the reviewed repo would make answer collection depend on a clone it never reads.
 */
export const reviewerRoot = projectRoot;

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
  await ensureCommitPresent(dir, headSha);
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
/**
 * A resumed round checks out the SHA it was created for, which an ordinary fetch only provides while
 * that commit is still reachable from a ref. Squash, rebase or force-push the branch between the
 * report and the answer and it is not — `git checkout` then fails with `unable to read tree`, which
 * says nothing about what happened. Ask for the commit directly first, and if the remote no longer
 * has it, say so in terms that name the cause.
 */
async function ensureCommitPresent(dir: string, sha: string): Promise<void> {
  const present = async () => {
    try {
      await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (await present()) return;
  try {
    await git(dir, ['fetch', 'origin', sha]);
  } catch {
    // Servers may refuse to serve an arbitrary SHA; the check below reports it either way.
  }
  if (await present()) return;
  throw new Error(
    `commit ${sha.slice(0, 10)} is no longer on the remote — the branch was force-pushed, squashed ` +
      'or rebased since this round began, so the round cannot be resumed against it; comment on the ' +
      'PR to start a fresh round on the new head',
  );
}

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

/**
 * Push the workspace's HEAD to a branch, surfacing git's own words on failure.
 *
 * The fixer pushes for itself, inside its agent run, so when that push is rejected the reason stays
 * in the agent's transcript and all the reviewer ever saw was that the branch had not moved. Worth
 * owning for two reasons: a rejection we can read is a rejection we can report (an App token is
 * refused outright for a .github/workflows change without the Workflows permission, which looks
 * identical to every other failure from outside), and a transient rejection we can simply retry.
 */
export async function pushHeadTo(dir: string, branch: string): Promise<{ pushed: boolean; error: string | null }> {
  try {
    await git(dir, ['push', 'origin', `HEAD:${branch}`]);
    return { pushed: true, error: null };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || 'unknown error').trim();
    return { pushed: false, error: detail.split('\n').slice(0, 6).join('\n') };
  }
}

/** The commit the workspace is sitting on — what the fixer produced, before anyone else pushed. */
export async function localHeadSha(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * The identity this workspace commits under, read where the commit actually gets it. The environment
 * variable is only one of the ways it can be set — ensureCommitIdentity accepts a global git config
 * too — so comparing against the variable left the check silently disabled in exactly the setups that
 * do not use it.
 */
export async function configuredAuthorEmail(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['config', '--get', 'user.email']);
  } catch {
    return null;
  }
}

/** Author email of a ref's head — the evidence for whether a commit is one of ours. */
export async function commitAuthorEmail(dir: string, ref: string): Promise<string> {
  return git(dir, ['log', '-1', '--format=%ae', ref]);
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
  /** The command was killed for exceeding its budget — not the same thing as a failing test. */
  timedOut?: boolean;
}

/**
 * How long one repo command may run. Ten minutes was chosen against laptop timings; a 2-core runner
 * with a cold `npm ci` can push a suite that takes four minutes locally well past it, and a killed
 * suite used to be recorded as a plain FAIL and fed to ten auditors as evidence of broken code.
 */
const COMMAND_TIMEOUT_MS = positiveIntEnv('REVIEWER_COMMAND_TIMEOUT_MS', 10 * 60 * 1000);

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

/**
 * A home directory of its own for the reviewed repo's commands.
 *
 * Moving the checkout out of the reviewer's install tree did not protect the thing that mattered
 * most: the git credential helper is named in the global git config, and HOME was shared — so an
 * install script in the repo under review could rewrite ~/.gitconfig and have the fixer's later push
 * hand its token to a helper of the repo's choosing. The same HOME also holds ~/.claude and ~/.npmrc.
 * Nothing a setup or test command legitimately does needs any of it.
 *
 * The fixer keeps the real HOME, because its own `git push` is what the helper exists for.
 */
function repoCommandHome(source: NodeJS.ProcessEnv): string | null {
  const root = source.REVIEWER_WORKSPACE_ROOT?.trim();
  if (!root) return null; // local runs keep today's behaviour rather than surprising a laptop
  const home = path.join(root, 'repo-home');
  try {
    fs.mkdirSync(home, { recursive: true });
    return home;
  } catch {
    return null;
  }
}

/** The environment a reviewed repo's own command gets: ours, minus anything that is ours. */
export function repoCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, CI: 'true' };
  const home = repoCommandHome(source);
  if (home) env.HOME = home;
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
  timeoutMs = COMMAND_TIMEOUT_MS,
  maxBuffer = 32 * 1024 * 1024,
): Promise<CommandResult> {
  try {
    await execFileAsync('sh', ['-c', command], {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer,
      env: repoCommandEnv(),
    });
    return { passed: true, trimmedOutput: null };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
      code?: string;
    };
    const combined = [e.stdout ?? '', e.stderr ?? ''].join('\n');
    // execFile reports a timeout by killing the child, so this is the only way to tell a suite that
    // failed from one that never got to finish. Reporting them the same way invents a failure, and
    // whatever output was salvaged is a partial log that looks like the explanation for it.
    // A command killed for flooding its output buffer is no more a failing test than one killed for
    // running too long: execFile reports it with its own code, and treating it as FAIL fed auditors a
    // truncated log as the explanation for a failure that never happened.
    const overflowed = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const timedOut = !overflowed && (e.killed === true || e.signal === 'SIGTERM');
    let body: string;
    if (timedOut) {
      body =
        `(killed after ${Math.round(timeoutMs / 60_000)} minutes — the output below is partial)\n` +
        trimOutput(combined || '(no output before the command was killed)');
    } else if (overflowed) {
      body =
        '(killed after writing more output than the reviewer will buffer — the output below is the ' +
        'start of it, and says nothing about whether the suite would have passed)\n' +
        trimOutput(combined || '(no output captured)');
    } else {
      body = trimOutput(combined || (e.message ?? 'unknown error'));
    }
    return { passed: false, trimmedOutput: body, timedOut: timedOut || overflowed };
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
