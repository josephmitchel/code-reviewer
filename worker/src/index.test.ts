import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appJwt, decodePem, importAppKey, reposDue, wrapPkcs1InPkcs8 } from './index.js';
import { REPOS } from './repos.js';

/**
 * The Worker's only hard parts are the ones that fail nowhere but against GitHub at 07:17 UTC:
 * turning the key GitHub downloads (PKCS#1) into one Web Crypto accepts, signing the JWT the way
 * GitHub checks it, and firing the right repo on the right cron.
 */

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const pkcs8Pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('importAppKey', () => {
  it('accepts the PKCS#1 key GitHub downloads and signs with it', async () => {
    expect(decodePem(pair.privateKey).label).toBe('RSA PRIVATE KEY');
    const key = await importAppKey(pair.privateKey);
    const data = new TextEncoder().encode('hello');
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
    expect(verify('RSA-SHA256', data, pair.publicKey, new Uint8Array(sig))).toBe(true);
  });

  it('accepts a PKCS#8 key too', async () => {
    const key = await importAppKey(pkcs8Pem.privateKey);
    const data = new TextEncoder().encode('hello');
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
    expect(verify('RSA-SHA256', data, pkcs8Pem.publicKey, new Uint8Array(sig))).toBe(true);
  });

  it('wraps PKCS#1 bytes in exactly the PKCS#8 envelope Node produces', () => {
    const pkcs1 = decodePem(pair.privateKey).der;
    const wrapped = wrapPkcs1InPkcs8(pkcs1);
    // Envelope: SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 }
    expect(wrapped[0]).toBe(0x30);
    expect(Array.from(wrapped.slice(wrapped.length - pkcs1.length))).toEqual(Array.from(pkcs1));
    expect(Array.from(wrapped).join(',')).toContain('2,1,0,48,13,6,9,42,134,72,134,247,13,1,1,1,5,0,4,130');
  });

  it('refuses anything that is not an RSA private key', async () => {
    await expect(importAppKey(pair.publicKey)).rejects.toThrow(/unsupported key type "PUBLIC KEY"/);
    await expect(importAppKey('nope')).rejects.toThrow(/not a PEM block/);
  });
});

describe('appJwt', () => {
  it('is RS256, issued by the client id, backdated a minute and short-lived, and verifiable', async () => {
    const key = await importAppKey(pair.privateKey);
    const now = 1_800_000_000;
    const jwt = await appJwt('Iv1.abc123', key, now);
    const [h, p, s] = jwt.split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(p)).toEqual({ iat: now - 60, exp: now + 540, iss: 'Iv1.abc123' });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pair.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('schedule', () => {
  it('fires only the repos on the cron that rang', () => {
    const repos = [
      { slug: 'a/one', cron: '17 7 * * *' },
      { slug: 'a/two', cron: '17 8 * * *' },
      { slug: 'a/three', cron: '17 7 * * *' },
    ];
    expect(reposDue(repos, '17 7 * * *').map((r) => r.slug)).toEqual(['a/one', 'a/three']);
    expect(reposDue(repos, '0 0 * * *')).toEqual([]);
  });

  it('lists every repo cron in wrangler.toml, so no repo is scheduled on a trigger that never fires', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const crons = [...toml.match(/crons\s*=\s*\[([^\]]*)\]/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const r of REPOS) expect(crons, `${r.slug} runs on "${r.cron}"`).toContain(r.cron);
    expect(new Set(REPOS.map((r) => r.cron)).size, 'one repo per slot').toBe(REPOS.length);
  });
});
