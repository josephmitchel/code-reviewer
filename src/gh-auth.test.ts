import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { appJwt, isFresh, resetTokenCacheForTests } from './gh-auth.js';

/**
 * Two things here fail nowhere but in production. The refresh margin decides whether a two-hour
 * round still has a working credential when the fixer finally pushes — the one operation whose
 * failure throws away the whole round. And the JWT signing is only ever validated by GitHub, so
 * a wrong algorithm or encoding looks perfect locally and 401s in CI.
 */

const MINUTE = 60 * 1000;
const token = (expiresInMs: number) => ({ token: 'ghs_x', expiresAt: Date.now() + expiresInMs });

afterEach(() => {
  resetTokenCacheForTests();
  delete process.env.REVIEWER_APP_CLIENT_ID;
  delete process.env.REVIEWER_APP_PRIVATE_KEY;
});

describe('isFresh', () => {
  it('has nothing to reuse before the first mint', () => {
    expect(isFresh(null, Date.now())).toBe(false);
  });

  it('reuses a token with most of its hour left', () => {
    expect(isFresh(token(55 * MINUTE), Date.now())).toBe(true);
  });

  it('refreshes inside the margin, while the old token still works', () => {
    // The point of refreshing early: this token is valid for five more minutes, and a push
    // five minutes from now would be the thing that fails.
    expect(isFresh(token(5 * MINUTE), Date.now())).toBe(false);
  });

  it('refreshes exactly at the margin rather than betting on the boundary', () => {
    const now = Date.now();
    expect(isFresh({ token: 'ghs_x', expiresAt: now + 10 * MINUTE }, now)).toBe(false);
  });

  it('refreshes an already-expired token', () => {
    expect(isFresh(token(-MINUTE), Date.now())).toBe(false);
  });
});

describe('appJwt', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  function parse(jwt: string) {
    const [header, payload, signature] = jwt.split('.');
    return {
      header: JSON.parse(Buffer.from(header, 'base64url').toString()),
      payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
      verified: crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    };
  }

  it('signs a verifiable RS256 token with the app client id as issuer', () => {
    process.env.REVIEWER_APP_CLIENT_ID = 'Iv23liABCDEF';
    process.env.REVIEWER_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const { header, payload, verified } = parse(appJwt());
    expect(verified).toBe(true);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('Iv23liABCDEF');
    // GitHub rejects an expiry more than ten minutes out, and backdates guard clock skew.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.iat).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it('accepts the PKCS#1 PEM that GitHub actually hands you', () => {
    // GitHub's downloaded .pem is "BEGIN RSA PRIVATE KEY" (PKCS#1), not PKCS#8.
    process.env.REVIEWER_APP_CLIENT_ID = 'Iv23liABCDEF';
    process.env.REVIEWER_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    expect(parse(appJwt()).verified).toBe(true);
  });
});
