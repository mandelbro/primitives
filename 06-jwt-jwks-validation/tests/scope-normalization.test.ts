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

describe('scope normalization (E1)', () => {
  let key: KeyMaterial;
  beforeAll(async () => {
    key = await generateTestKeyPair('kid-1');
  });

  it.each<{
    name: string;
    input: unknown;
    expected: string[];
    expectClaimsScope?: unknown;
  }>([
    { name: 'space-delimited string', input: 'read write', expected: ['read', 'write'] },
    {
      name: 'string with leading/trailing whitespace',
      input: '   read   write  ',
      expected: ['read', 'write'],
    },
    { name: 'whitespace-only string', input: '   ', expected: [] },
    { name: 'array of strings', input: ['read', 'write'], expected: ['read', 'write'] },
    {
      name: 'array with non-strings and empties',
      input: ['read', '', 42, null, 'write'],
      expected: ['read', 'write'],
    },
    { name: 'number', input: 42, expected: [] },
    { name: 'object', input: { foo: 'bar' }, expected: [] },
    { name: 'null', input: null, expected: [] },
  ])('$name → $expected', async ({ input, expected }) => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }));
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'u',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
      scope: input,
    });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.auth.scope).toEqual(expected);
    // Verbatim preservation on claims (when present).
    expect(res.body.auth.claims.scope).toEqual(input);
  });

  it('missing scope claim → req.auth.scope = [] and claims.scope is undefined', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
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
    expect(res.status).toBe(200);
    expect(res.body.auth.scope).toEqual([]);
    expect(res.body.auth.claims.scope).toBeUndefined();
  });
});
