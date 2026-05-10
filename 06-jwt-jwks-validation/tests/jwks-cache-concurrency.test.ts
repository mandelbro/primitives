import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import {
  defaultOpts,
  fakeFetcher,
  fakeNow,
  generateTestKeyPair,
  jwks,
  type KeyMaterial,
  mountApp,
  nowSec,
  signWithKey,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_JWKS_URI,
} from './fixtures.js';

describe('JWKS cache concurrency (D3, D4)', () => {
  let key: KeyMaterial;

  beforeAll(async () => {
    key = await generateTestKeyPair('kid-1');
  });

  function validClaims(clockMs: number): Parameters<typeof signWithKey>[2] {
    return {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'u',
      exp: nowSec(clockMs) + 3600,
      iat: nowSec(clockMs),
    };
  }

  it('D3: concurrent kid-misses share one in-flight refresh', async () => {
    const fetcher = fakeFetcher();
    // Single response, but with a small delay so both requests await it.
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]), delayMs: 50 });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));

    const [r1, r2] = await Promise.all([
      request(app).get('/protected').set('Authorization', `Bearer ${token}`),
      request(app).get('/protected').set('Authorization', `Bearer ${token}`),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);
  });

  it('D4: rejected refresh clears in-flight; next request retriggers fetch', async () => {
    const fetcher = fakeFetcher();
    // First fetch fails; second fetch succeeds.
    fetcher.enqueueError(TEST_JWKS_URI, new Error('upstream down'));
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));

    const r1 = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(r1.status).toBe(401);
    expect(r1.headers['www-authenticate']).toContain('unknown kid');
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);

    // The .finally() must have cleared inFlight; second request should refetch.
    const r2 = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(r2.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(2);
  });
});
