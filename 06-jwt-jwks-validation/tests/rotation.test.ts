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

// Walks the spec §13 zero-downtime key-rotation flow as a single observable
// sequence. If a future change breaks rotation, this test should fail loud
// with a pinpoint to which step regressed.
describe('zero-downtime key rotation (I1)', () => {
  it('walks the §13 planned rotation flow end-to-end', async () => {
    const keyA = await generateTestKeyPair('kid-A');
    const keyB = await generateTestKeyPair('kid-B');

    const fetcher = fakeFetcher();
    // Step 1: only A is published.
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyA.publicJwk]) });
    // Step 2: A and B both published (overlap window).
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyA.publicJwk, keyB.publicJwk]) });
    // Step 4: only B is published (A retired).
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyB.publicJwk]) });
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyB.publicJwk]) });

    const clock = fakeNow();
    const cacheTtlMs = 60_000;
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, cacheTtlMs }),
    );

    const claims = (kid: string) => ({
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: `user-with-${kid}`,
      exp: nowSec(clock.now()) + 7200,
      iat: nowSec(clock.now()),
    });

    // ── Step 1 ────────────────────────────────────────────────────────────
    // Cold start: kid-A token. JWKS publishes only kid-A. First request
    // populates the cache via the first refresh.
    const tokenA1 = await signWithKey(keyA.privateKey, keyA.kid, claims('A'));
    const r1 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenA1}`);
    expect(r1.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);

    // ── Step 2 ────────────────────────────────────────────────────────────
    // IdP now advertises both A and B. A new kid-B token arrives.
    // It's a kid-miss → exactly one refresh → both kids cached.
    const tokenB1 = await signWithKey(keyB.privateKey, keyB.kid, claims('B'));
    const r2 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenB1}`);
    expect(r2.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(2);

    // ── Step 3 ────────────────────────────────────────────────────────────
    // A second kid-A token now hits the cache (which was replaced with
    // {A, B} in step 2). No additional fetch.
    const tokenA2 = await signWithKey(keyA.privateKey, keyA.kid, claims('A'));
    const r3 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenA2}`);
    expect(r3.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(2);

    // ── Step 4 ────────────────────────────────────────────────────────────
    // IdP retires A. Advance clock past TTL. The next request triggers a
    // refresh which now returns only B; A is evicted. Subsequent kid-A
    // tokens fail; kid-B tokens succeed.
    clock.advance(cacheTtlMs + 1);

    const tokenA3 = await signWithKey(keyA.privateKey, keyA.kid, claims('A'));
    const r4 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenA3}`);
    expect(r4.status).toBe(401);
    expect(r4.headers['www-authenticate']).toContain('unknown kid');

    const tokenB2 = await signWithKey(keyB.privateKey, keyB.kid, claims('B'));
    const r5 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenB2}`);
    expect(r5.status).toBe(200);
  });
});
