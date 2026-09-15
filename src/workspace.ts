import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function workspacePath(repoSlug: string): string {
  return path.join(projectRoot, 'workspaces', repoSlug.replace('/', '__'));
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
  return dir;
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
      env: { ...process.env, CI: 'true' },
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
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const interesting = lines.filter(
    (l) => /fail|error|✗|✘|×|assert|expect|Δ|throw/i.test(l) && !/^npm (warn|notice)/i.test(l),
  );
  const chosen = interesting.length > 0 ? interesting.slice(0, 60) : lines.slice(-40);
  return chosen.join('\n').slice(0, 8000);
}
