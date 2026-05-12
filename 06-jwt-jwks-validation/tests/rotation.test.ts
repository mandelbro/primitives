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

// §13 emergency revocation. The spec promises that when a compromised kid is
// removed from JWKS out-of-band, the worst-case exposure window is one
// `cacheTtlMs`. I1 step 4 exercises a similar path, but inside a planned
// rotation where the cache had previously been refreshed with an overlap
// window {A, B}. This test isolates the pure emergency case: cache contains
// only the revoked kid, no overlap window, no advance warning — just TTL
// expiry plus one subsequent request to the revoked kid.
describe('emergency revocation (§13, I2)', () => {
  it('TTL expiry alone evicts a silently-yanked kid on the next request', async () => {
    const keyA = await generateTestKeyPair('kid-A');
    // keyB is the post-yank publication; the IdP rotates to a fresh kid
    // without any overlap window from the cache's perspective.
    const keyB = await generateTestKeyPair('kid-B');

    const fetcher = fakeFetcher();
    // Initial fetch: only kid-A published.
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyA.publicJwk]) });
    // After silent yank: kid-A is gone, kid-B is published.
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyB.publicJwk]) });

    const clock = fakeNow();
    const cacheTtlMs = 60_000;
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, cacheTtlMs }),
    );

    const claims = (kid: string) => ({
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: `user-${kid}`,
      exp: nowSec(clock.now()) + 7200,
      iat: nowSec(clock.now()),
    });

    // Phase 1: warm the cache with kid-A. After this, the cache holds
    // exactly {kid-A}.
    const tokenA1 = await signWithKey(keyA.privateKey, keyA.kid, claims('A'));
    const r1 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenA1}`);
    expect(r1.status).toBe(200);
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(1);

    // Phase 2: IdP silently yanks kid-A. We make NO requests during the
    // TTL window — the §13 guarantee is that TTL expiry alone is
    // sufficient to bound the exposure, without any unknown-kid traffic
    // arriving to trigger an earlier refresh.
    clock.advance(cacheTtlMs + 1);

    // Phase 3: a kid-A token arrives after TTL expiry. The cached entry
    // is past TTL → cache treats it as a miss → refresh fires → JWKS
    // now contains only kid-B → kid-A absent → 401. The refresh fires
    // because of THIS request (one additional fetch).
    const tokenA2 = await signWithKey(keyA.privateKey, keyA.kid, claims('A'));
    const r2 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenA2}`);
    expect(r2.status).toBe(401);
    expect(r2.headers['www-authenticate']).toContain('unknown kid');
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(2);
  });
});
