import { appAuthConfigured, installationToken } from './gh-auth.js';

/**
 * git's credential helper protocol: git writes `key=value` lines on stdin and reads
 * `username=` / `password=` back on stdout. Only `get` for github.com is answered, and
 * `store`/`erase` are deliberately no-ops — nothing is persisted, which is the whole point: each
 * request mints or reuses a token that is still valid now.
 *
 * This is how the *fixer agent's* own `git push` authenticates. It runs that command itself, at the
 * end of a round that may have started before the current token existed, so there is no command
 * line we could have put a token on.
 *
 * Deliberately free of any database import. It used to be a `code-reviewer` subcommand, which meant
 * loading the CLI — and with it the Postgres client, which throws without DATABASE_URL. Keeping the
 * reviewer's connection string out of this process is what lets the fixer's environment drop it, and
 * with it the reviewed repo's test suite seeing where the reviewer keeps its own data.
 */
export async function gitCredential(operation: string, stdin: AsyncIterable<Buffer | string>): Promise<string | null> {
  if (operation !== 'get' || !appAuthConfigured()) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
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
  if (fields.get('host') !== 'github.com') return null;

  return `username=x-access-token\npassword=${await installationToken()}\n`;
}
