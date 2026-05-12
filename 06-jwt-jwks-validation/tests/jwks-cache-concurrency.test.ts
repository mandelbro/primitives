import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { JwksCache } from '../src/jwks-cache.js';
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

  it('D3: concurrent kid-misses share one in-flight refresh (integration)', async () => {
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

  // Structural sibling to D3: exercises JwksCache.getKey directly with a
  // deferred fetcher we control. The single-flight invariant is observable
  // synchronously between the two getKey calls — if it were broken, the
  // second call would have incremented fetchCallCount BEFORE the assertion
  // below runs. The integration D3 above can pass under interleavings
  // where the cache happens to populate between the two requests; this
  // structural pin doesn't depend on timing.
  it('D3 structural: two getKey() calls share one in-flight fetch (cache-API contract)', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    let fetchCallCount = 0;
    const fetcher: typeof fetch = async () => {
      fetchCallCount++;
      return fetchPromise;
    };

    const cache = new JwksCache({
      jwksUri: TEST_JWKS_URI,
      cacheTtlMs: 60_000,
      fetcher,
      now: Date.now,
    });

    // Fire both calls synchronously, without awaiting. The synchronous
    // prefix of each getKey() must enter refresh() and observe the same
    // in-flight promise.
    const p1 = cache.getKey(key.kid);
    const p2 = cache.getKey(key.kid);

    // The crucial assertion: only ONE fetcher invocation despite two
    // concurrent getKey() calls. If single-flight regressed (e.g. the
    // `if (this.inFlight) return this.inFlight` check were removed from
    // JwksCache.refresh), this would be 2 right here.
    expect(fetchCallCount).toBe(1);

    // Resolve the deferred fetch with a valid JWKS body so both
    // getKey calls can complete.
    resolveFetch(
      new Response(JSON.stringify(jwks([key.publicJwk])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const [k1, k2] = await Promise.all([p1, p2]);
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(fetchCallCount).toBe(1);
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
