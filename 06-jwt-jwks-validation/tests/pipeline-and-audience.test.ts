import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  craftRawJwt,
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

describe('pipeline ordering (B1) — security invariant', () => {
  it('alg=none + expired exp + tampered signature → "unsupported alg" wins', async () => {
    const key = await generateTestKeyPair('kid-1');
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );

    // alg=none + expired exp + signature segment that would never validate.
    const token = craftRawJwt(
      { alg: 'none', kid: 'kid-1' },
      {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: 'user-1',
        exp: nowSec(clock.now()) - 9999,
      },
      'aaaaaa-tampered',
    );

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const header = res.headers['www-authenticate']!;
    expect(res.status).toBe(401);
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain('error_description="unsupported alg"');
    // Sanity: it must NOT have escaped to a downstream description.
    expect(header).not.toContain('token expired');
    expect(header).not.toContain('invalid signature');
  });
});

describe('aud flexibility (A4)', () => {
  it('token aud is array containing configured string → valid', async () => {
    const key = await generateTestKeyPair('kid-1');
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, audience: TEST_AUDIENCE }),
    );
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: [TEST_AUDIENCE, 'urn:other:api'],
      sub: 'user-1',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.auth.sub).toBe('user-1');
  });

  it('configured audience is array; token aud is a single member → valid', async () => {
    const key = await generateTestKeyPair('kid-1');
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        audience: ['urn:test:api', 'urn:test:other'],
      }),
    );
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: 'urn:test:other',
      sub: 'user-1',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
