import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  defaultOpts,
  fakeFetcher,
  fakeNow,
  generateTestKeyPair,
  jwks,
  mountApp,
  nowSec,
  signWithKey,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_JWKS_URI,
} from './fixtures.js';

describe('auth contract — happy path (A1)', () => {
  it('200, populates req.auth, calls next() with full claims and normalized scope', async () => {
    const key = await generateTestKeyPair('kid-1');
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();

    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
      }),
    );

    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'user-42',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
      scope: 'read write',
    });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.auth.sub).toBe('user-42');
    expect(res.body.auth.scope).toEqual(['read', 'write']);
    expect(res.body.auth.claims.sub).toBe('user-42');
    expect(res.body.auth.claims.iss).toBe(TEST_ISSUER);
    expect(res.body.auth.claims.aud).toBe(TEST_AUDIENCE);
    expect(typeof res.body.auth.claims.exp).toBe('number');
    expect(res.body.auth.claims.scope).toBe('read write');
  });
});

describe('auth contract — missing credentials (A2)', () => {
  it('returns 401 with WWW-Authenticate: Bearer realm="api" and no error parameter', async () => {
    const app = mountApp(defaultOpts());
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="api"');
  });

  it('uses a custom realm when configured', async () => {
    const app = mountApp(defaultOpts({ realm: 'my-realm' }));
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="my-realm"');
  });
});
