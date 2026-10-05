import crypto from 'node:crypto';

/**
 * GitHub App authentication for CI runs.
 *
 * A round can take two hours and an installation token lives one, so a token handed to the
 * job at startup is dead by the time the fixer pushes — the one operation whose failure wastes
 * the entire round. Nothing here is long-lived: a token is minted on demand and re-minted
 * before it expires, so every `gh` call and every git network operation gets a fresh one.
 *
 * With the App variables unset (a local run) all of this stays out of the way and the ambient
 * `gh` login is used instead.
 */

const CLIENT_ID_VAR = 'REVIEWER_APP_CLIENT_ID';
const PRIVATE_KEY_VAR = 'REVIEWER_APP_PRIVATE_KEY';
const INSTALL_REPO_VAR = 'REVIEWER_APP_INSTALL_REPO';

/**
 * Re-mint this far before expiry. Generous because the cost of being early is one extra API
 * call, and the cost of being late is a failed push at the end of an hours-long round.
 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** GitHub rejects an app JWT whose `exp` is more than 10 minutes out; stay clear of the edge. */
const JWT_LIFETIME_S = 540;

interface CachedToken {
  token: string;
  /** Epoch ms from GitHub's own `expires_at` — never computed from a local clock. */
  expiresAt: number;
}

let cached: CachedToken | null = null;
let configuredRepo: string | null = null;

/** True when this process has App credentials and should mint its own tokens. */
export function appAuthConfigured(): boolean {
  return Boolean(process.env[CLIENT_ID_VAR] && process.env[PRIVATE_KEY_VAR]);
}

/**
 * Name the repo whose installation to use. The CLI knows it from its arguments; the git
 * credential helper is invoked by git with no arguments at all, so it falls back to the
 * environment variable the workflow exports.
 */
export function configureAppAuth(repoSlug: string): void {
  configuredRepo = repoSlug;
}

function authRepo(): string {
  const slug = configuredRepo ?? process.env[INSTALL_REPO_VAR] ?? null;
  if (!slug) {
    throw new Error(
      `App auth needs the repo whose installation to use — set ${INSTALL_REPO_VAR}=owner/repo`,
    );
  }
  return slug;
}

/** Whether a cached token can still be used, given when it expires and how early we refresh. */
export function isFresh(token: CachedToken | null, now: number, margin = REFRESH_MARGIN_MS): boolean {
  return token !== null && token.expiresAt - now > margin;
}

/**
 * A JWT signed with the app's private key, which authenticates as the *app* (not as an
 * installation) for exactly the two calls below. `iss` is the client id; GitHub also still
 * accepts the numeric app id there. Exported so the signing itself is testable — a wrong
 * algorithm here fails nowhere but against GitHub.
 */
export function appJwt(): string {
  const clientId = process.env[CLIENT_ID_VAR]!;
  const privateKey = process.env[PRIVATE_KEY_VAR]!;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Backdated `iat` absorbs clock skew between the runner and GitHub.
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + JWT_LIFETIME_S,
    iss: clientId,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

async function githubApi<T>(path: string, jwt: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'code-reviewer',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** A usable installation token, minted or reused. */
export async function installationToken(): Promise<string> {
  if (isFresh(cached, Date.now())) return cached!.token;

  const jwt = appJwt();
  // Resolving the installation from the repo avoids carrying an installation id as a secret:
  // it is derivable, and one less thing to re-paste when the app is reinstalled.
  const installation = await githubApi<{ id: number }>(`/repos/${authRepo()}/installation`, jwt);
  const minted = await githubApi<{ token: string; expires_at: string }>(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    'POST',
  );
  cached = { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
  // stderr, not stdout: when git invokes the credential helper, stdout is the protocol.
  console.error(`minted installation token, expires ${minted.expires_at}`);
  return cached.token;
}

/** Only for tests: forget the cached token. */
export function resetTokenCacheForTests(): void {
  cached = null;
  configuredRepo = null;
}
