import { describe, expect, it } from 'vitest';
import { repoCommandEnv, runRepoCommand } from './workspace.js';

/**
 * The reviewed repo's setup and test commands are arbitrary code — `npm ci` alone runs that
 * repo's install scripts. Handing them the reviewer's own environment leaks the App private key
 * that can push to the repo, the credential that pays for the review, and a connection string
 * to the reviewer's database. The last one nearly caused real damage: spendright's db suite
 * falls back to `DATABASE_URL`, so on the first CI run it aimed at the reviewer's Neon database
 * and was stopped only by a `_test`-suffix guard in spendright's own test helper.
 */
describe('repoCommandEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    DATABASE_URL: 'postgresql://user:pw@host/neondb',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    GH_TOKEN: 'ghs_secret',
    GITHUB_TOKEN: 'ghs_secret',
    REVIEWER_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----',
    REVIEWER_APP_CLIENT_ID: 'Iv23li',
    REVIEWER_AGENT_CONCURRENCY: '5',
  };

  it('strips every reviewer-owned credential', () => {
    const env = repoCommandEnv(source);
    for (const key of [
      'DATABASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'REVIEWER_APP_PRIVATE_KEY',
      'REVIEWER_APP_CLIENT_ID',
      'REVIEWER_AGENT_CONCURRENCY',
    ]) {
      expect(env, `${key} must not reach the reviewed repo`).not.toHaveProperty(key);
    }
  });

  it('keeps what a build actually needs, and marks the run as CI', () => {
    const env = repoCommandEnv(source);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.CI).toBe('true');
  });

  it('does not mutate the environment it was given', () => {
    repoCommandEnv(source);
    expect(source.DATABASE_URL).toBe('postgresql://user:pw@host/neondb');
  });

  it('strips any future REVIEWER_-prefixed variable without being told', () => {
    expect(repoCommandEnv({ ...source, REVIEWER_SOMETHING_NEW: 'x' })).not.toHaveProperty(
      'REVIEWER_SOMETHING_NEW',
    );
  });
});

/**
 * The carrier exists because the first version of repo-env shell-exported the lines in the action,
 * which put repo-supplied names into the REVIEWER's own environment — a repo could name
 * DATABASE_URL and repoint the reviewer at a database of its choosing. Applying them only to the
 * child both closes that and makes the feature work: the names a repo most wants to set for its
 * own suites are exactly the ones on the strip list.
 */
describe('repoCommandEnv with a repo-env carrier', () => {
  const withCarrier = (carrier: string) =>
    repoCommandEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgresql://reviewer/neondb',
      REVIEWER_APP_PRIVATE_KEY: 'secret',
      REVIEWER_REPO_ENV: carrier,
    });

  it('passes the repo its own variables', () => {
    const env = withCarrier('TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_test');
    expect(env.TEST_DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/app_test');
  });

  it('lets a repo set a name that is otherwise stripped, with the reviewer\'s value gone', () => {
    const env = withCarrier('DATABASE_URL=postgresql://localhost:5432/app_test');
    expect(env.DATABASE_URL).toBe('postgresql://localhost:5432/app_test');
    expect(env.DATABASE_URL).not.toContain('neondb');
  });

  it('never leaks the carrier itself, nor the credentials beside it', () => {
    const env = withCarrier('FOO=bar');
    expect(env).not.toHaveProperty('REVIEWER_REPO_ENV');
    expect(env).not.toHaveProperty('REVIEWER_APP_PRIVATE_KEY');
  });

  it('keeps values containing = and spaces intact', () => {
    const env = withCarrier('URL=postgres://h/db?a=1&b=2\nMSG=two words');
    expect(env.URL).toBe('postgres://h/db?a=1&b=2');
    expect(env.MSG).toBe('two words');
  });

  it('skips blanks and comments, and survives a malformed line', () => {
    const env = withCarrier('\n# a comment\n=novalue\nGOOD=yes\n');
    expect(env.GOOD).toBe('yes');
    // chai cannot take an empty property path, so check the key set directly.
    expect(Object.keys(env)).not.toContain('');
  });

  it('is a no-op when no carrier is set', () => {
    expect(repoCommandEnv({ PATH: '/usr/bin' }).PATH).toBe('/usr/bin');
  });
});

/**
 * A command killed for running too long used to be recorded as `passed: false` with a partial log,
 * indistinguishable from a suite that genuinely failed — and ten auditors were then handed that log
 * as evidence of broken code. The detection relies on what execFile actually reports when it kills a
 * child, so this exercises a real process rather than trusting an assumption about `err.killed`.
 */
describe('runRepoCommand timeouts', () => {
  it('marks a command killed for exceeding its budget, and says so in the output', async () => {
    const res = await runRepoCommand('/tmp', 'sleep 5', 400);
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.trimmedOutput).toContain('killed after');
  });

  it('does not mark an ordinary failure as a timeout', async () => {
    const res = await runRepoCommand('/tmp', 'echo boom >&2; exit 1', 10_000);
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(false);
  });

  it('passes a command that succeeds', async () => {
    expect((await runRepoCommand('/tmp', 'true', 10_000)).passed).toBe(true);
  });
});

/**
 * Node reports a buffer overflow with its own code and leaves `killed` and `signal` undefined — so
 * without checking it first, a command drowned in output falls through to the generic branch and is
 * reported as a failing test, with a truncated log standing in as the explanation.
 */
describe('runRepoCommand output overflow', () => {
  it('reports a command killed for flooding its buffer as inconclusive, not failed', async () => {
    const res = await runRepoCommand('/tmp', 'yes hello', 10_000, 1024);
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(true); // carried on the same flag: both mean "this says nothing"
    expect(res.trimmedOutput).toContain('more output than the reviewer will buffer');
  });
});

/**
 * The reviewed repo's install and test commands are arbitrary code, and HOME is where the git
 * credential helper is named (~/.gitconfig), alongside ~/.claude and ~/.npmrc. An install script that
 * rewrote the helper would have the fixer's later push hand its token wherever the repo chose.
 */
describe('repoCommandEnv home isolation', () => {
  it('redirects HOME when a workspace root is configured', () => {
    const env = repoCommandEnv({
      HOME: '/Users/someone',
      REVIEWER_WORKSPACE_ROOT: '/tmp/claude-reviewer-home-test',
    });
    expect(env.HOME).toBe('/tmp/claude-reviewer-home-test/repo-home');
    expect(env.HOME).not.toBe('/Users/someone');
  });

  it('leaves HOME alone with no workspace root, so a laptop behaves as before', () => {
    expect(repoCommandEnv({ HOME: '/Users/someone' }).HOME).toBe('/Users/someone');
  });
});
