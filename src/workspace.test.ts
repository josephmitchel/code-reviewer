import { describe, expect, it } from 'vitest';
import { repoCommandEnv } from './workspace.js';

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
