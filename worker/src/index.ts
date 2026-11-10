import { REPOS, type SweptRepo } from './repos.js';

/**
 * A Cloudflare Worker that dispatches each repo's `nightly-sweep.yml` on time, authenticated as the
 * reviewer's own GitHub App: a JWT signed with the App's key, an installation token scoped to that
 * one repository and `actions: write`, one POST to the workflow's dispatch endpoint. Nothing here
 * expires — the key is the App's — so the sweep cannot stop silently in a year the way a personal
 * token would. A failed dispatch throws, which Cloudflare records as a failed cron invocation.
 */

export interface Env {
  /** The App's client id (`Iv1.…` or `Iv23…`); GitHub also accepts the numeric app id as `iss`. */
  GITHUB_APP_CLIENT_ID: string;
  /** The App's private key, PEM, as downloaded from GitHub (PKCS#1) or converted to PKCS#8. */
  GITHUB_APP_PRIVATE_KEY: string;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export const WORKFLOW_FILE = 'nightly-sweep.yml';
const API = 'https://api.github.com';
const USER_AGENT = 'code-reviewer-sweep-trigger';
/** GitHub rejects an App JWT whose `exp` is more than 10 minutes out; stay clear of the edge. */
const JWT_LIFETIME_S = 540;

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const due = reposDue(REPOS, controller.cron);
    if (due.length === 0) {
      // A cron in wrangler.toml that no repo names is a configuration slip: say so where it is seen.
      throw new Error(`cron "${controller.cron}" fired but no repo in repos.ts is scheduled on it`);
    }
    const key = await importAppKey(env.GITHUB_APP_PRIVATE_KEY);
    const failures: string[] = [];
    for (const repo of due) {
      try {
        await dispatchSweep(env.GITHUB_APP_CLIENT_ID, key, repo);
        console.log(`dispatched ${WORKFLOW_FILE} on ${repo.slug}@${repo.ref ?? 'main'}`);
      } catch (err) {
        console.error(`${repo.slug}: ${String(err)}`);
        failures.push(repo.slug);
      }
    }
    if (failures.length > 0) throw new Error(`sweep dispatch failed for ${failures.join(', ')}`);
  },

  /** No HTTP surface. The Worker exists for its cron triggers. */
  async fetch(): Promise<Response> {
    return new Response('code-reviewer sweep trigger: cron only', { status: 404 });
  },
};

/** Pure: the repos whose cron is the one that fired. */
export function reposDue(repos: SweptRepo[], cron: string): SweptRepo[] {
  return repos.filter((r) => r.cron === cron);
}

async function dispatchSweep(clientId: string, key: CryptoKey, repo: SweptRepo): Promise<void> {
  const jwt = await appJwt(clientId, key);
  const [, name] = repo.slug.split('/');
  const installation = await github<{ id: number }>(`/repos/${repo.slug}/installation`, jwt);
  // Scoped down: a token that can start workflows on this one repo and nothing else. GitHub refuses
  // the request outright (422) if the installation lacks `actions: write`, which is the loud failure
  // wanted here rather than a token that silently cannot dispatch.
  const minted = await github<{ token: string }>(`/app/installations/${installation.id}/access_tokens`, jwt, {
    repositories: [name],
    permissions: { actions: 'write' },
  });
  const res = await fetch(`${API}/repos/${repo.slug}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    headers: headers(minted.token),
    body: JSON.stringify({ ref: repo.ref ?? 'main' }),
  });
  if (res.status !== 204) {
    throw new Error(`dispatch returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function github<T>(path: string, jwt: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers(jwt),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${body === undefined ? 'GET' : 'POST'} ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function headers(bearer: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
}

/** A JWT that authenticates as the App itself, good for the two calls that mint a token. */
export async function appJwt(clientId: string, key: CryptoKey, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const enc = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  // Backdated `iat` absorbs clock skew between here and GitHub.
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: nowS - 60, exp: nowS + JWT_LIFETIME_S, iss: clientId })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

/**
 * GitHub hands out App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`); Web Crypto imports only PKCS#8.
 * Both are accepted: a PKCS#1 body is wrapped in the PKCS#8 envelope here, so the key can be pasted
 * into the secret exactly as downloaded.
 */
export async function importAppKey(pem: string): Promise<CryptoKey> {
  const { label, der } = decodePem(pem);
  let pkcs8: Uint8Array<ArrayBuffer>;
  if (label === 'RSA PRIVATE KEY') pkcs8 = wrapPkcs1InPkcs8(der);
  else if (label === 'PRIVATE KEY') pkcs8 = der;
  else throw new Error(`unsupported key type "${label}" — expected an RSA private key in PEM form`);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export function decodePem(pem: string): { label: string; der: Uint8Array<ArrayBuffer> } {
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error('not a PEM block');
  const binary = atob(m[2].replace(/\s+/g, ''));
  const der = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return { label: m[1], der };
}

/** PrivateKeyInfo ::= SEQUENCE { version 0, algorithm rsaEncryption, privateKey OCTET STRING (the PKCS#1 bytes) } */
export function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryption = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const privateKey = der(0x04, pkcs1);
  return der(0x30, concat(version, rsaEncryption, privateKey));
}

function der(tag: number, contents: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = contents.length;
  let length: number[];
  if (n < 0x80) length = [n];
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    length = [0x80 | bytes.length, ...bytes];
  }
  return concat(Uint8Array.of(tag, ...length), contents);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
