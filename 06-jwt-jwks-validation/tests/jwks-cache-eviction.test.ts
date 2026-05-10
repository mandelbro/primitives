import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { jwtAuth } from '../src/jwt-auth.js';
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

describe('JWKS cache eviction & isolation (D5, D6)', () => {
  let keyA: KeyMaterial;
  let keyB: KeyMaterial;

  beforeAll(async () => {
    keyA = await generateTestKeyPair('kid-A');
    keyB = await generateTestKeyPair('kid-B');
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

  it('D5: replace-on-refresh evicts retired kids', async () => {
    const fetcher = fakeFetcher();
    // First refresh: only A.
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyA.publicJwk]) });
    // Second refresh: only B (A retired).
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyB.publicJwk]) });
    // Third refresh (triggered by the retired-A request): still only B.
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyB.publicJwk]) });

    const clock = fakeNow();
    const app = mountApp(defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }));

    const tokenA = await signWithKey(keyA.privateKey, keyA.kid, validClaims(clock.now()));
    const tokenB = await signWithKey(keyB.privateKey, keyB.kid, validClaims(clock.now()));

    // Request 1 with kid-A — populates cache with A.
    expect((await request(app).get('/protected').set('Authorization', `Bearer ${tokenA}`)).status).toBe(200);

    // Request 2 with kid-B — kid-miss → refresh → cache replaced with only B.
    expect((await request(app).get('/protected').set('Authorization', `Bearer ${tokenB}`)).status).toBe(200);

    // Request 3 with kid-A — A no longer cached → refresh → A still absent → 401.
    const r3 = await request(app).get('/protected').set('Authorization', `Bearer ${tokenA}`);
    expect(r3.status).toBe(401);
    expect(r3.headers['www-authenticate']).toContain('unknown kid');
  });

  it('D6: two jwtAuth instances share no cache state', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyA.publicJwk]) });
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([keyA.publicJwk]) });

    const clock = fakeNow();
    const opts = defaultOpts({ fetcher: fetcher.fetcher, now: clock.now });

    const app = express();
    app.get('/one', jwtAuth(opts), (req, res) => res.json({ auth: req.auth }));
    app.get('/two', jwtAuth(opts), (req, res) => res.json({ auth: req.auth }));

    const token = await signWithKey(keyA.privateKey, keyA.kid, validClaims(clock.now()));

    expect((await request(app).get('/one').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/two').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    // Each instance should have done its own fetch — no shared cache.
    expect(fetcher.callCountFor(TEST_JWKS_URI)).toBe(2);
  });
});

describe('JWKS upstream failure modes (D8)', () => {
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

  it('5xx → 401 unknown kid; logger called with status', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { status: 503, body: { error: 'down' } });
    const calls: { msg: string; ctx: Record<string, unknown> }[] = [];
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        logger: (msg, ctx) => calls.push({ msg, ctx }),
      }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('unknown kid');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.msg).toBe('jwks_fetch_error');
    expect(calls[0]!.ctx['url']).toBe(TEST_JWKS_URI);
    expect(calls[0]!.ctx['status']).toBe(503);
  });

  it('network error → 401 unknown kid; logger called with error message', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueueError(TEST_JWKS_URI, new Error('ECONNREFUSED'));
    const calls: { msg: string; ctx: Record<string, unknown> }[] = [];
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        logger: (msg, ctx) => calls.push({ msg, ctx }),
      }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('unknown kid');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx['error']).toBe('ECONNREFUSED');
  });

  it('malformed JSON body → 401 unknown kid; logger called', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueueRaw(TEST_JWKS_URI, '{not valid json');
    const calls: { msg: string; ctx: Record<string, unknown> }[] = [];
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        logger: (msg, ctx) => calls.push({ msg, ctx }),
      }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('unknown kid');
    expect(calls).toHaveLength(1);
  });

  it('JSON without keys array → 401 unknown kid; logger called', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: { not: 'jwks' } });
    const calls: { msg: string; ctx: Record<string, unknown> }[] = [];
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        logger: (msg, ctx) => calls.push({ msg, ctx }),
      }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('unknown kid');
    expect(calls).toHaveLength(1);
  });
});

describe('JWKS key filtering (D9)', () => {
  it.each<{ name: string; jwk: () => Record<string, unknown>; included: boolean }>([
    {
      name: 'kty: RSA, use: sig — included',
      jwk: () => ({ kty: 'RSA', use: 'sig' }),
      included: true,
    },
    {
      name: 'kty: RSA, use absent — included',
      jwk: () => {
        const j = { kty: 'RSA' } as Record<string, unknown>;
        return j;
      },
      included: true,
    },
    {
      name: 'kty: RSA, use: enc — filtered',
      jwk: () => ({ kty: 'RSA', use: 'enc' }),
      included: false,
    },
    {
      name: 'kty: EC, use: sig — filtered',
      jwk: () => ({ kty: 'EC', use: 'sig' }),
      included: false,
    },
  ])('$name', async ({ jwk: jwkOverrides, included }) => {
    const key = await generateTestKeyPair('kid-1');
    // Apply the test's kty/use overrides on top of the real RSA key material so
    // shape is realistic but signal flags vary.
    const merged = { ...key.publicJwk, ...jwkOverrides() };

    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([merged]) });
    const clock = fakeNow();
    const app = mountApp(defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }));

    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'u',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    if (included) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('unknown kid');
    }
  });
});
