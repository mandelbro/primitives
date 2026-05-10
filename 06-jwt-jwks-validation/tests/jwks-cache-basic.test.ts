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

describe('JWKS cache lifecycle — hit/miss/TTL (D1, D2, D7)', () => {
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

  it('D1: cache hit — repeat verify within TTL does not re-fetch', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }),
    );

    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);
  });

  it('D2: cache miss — first verify fetches once and succeeds', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }),
    );

    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);
  });

  it('D7: TTL expiry — request after now() advances past cacheTtlMs refetches', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const cacheTtlMs = 60_000;
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, cacheTtlMs }),
    );

    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));

    const r1 = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(r1.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);

    // Advance well past the TTL boundary.
    clock.advance(cacheTtlMs + 1);

    const r2 = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(r2.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(2);
  });
});
