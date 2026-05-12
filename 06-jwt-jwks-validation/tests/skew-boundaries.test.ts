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

describe('skew boundaries (C1, C2, C3)', () => {
  let key: KeyMaterial;

  beforeAll(async () => {
    key = await generateTestKeyPair('kid-1');
  });

  function exec(opts: { clockSkewSec: number }) {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        clockSkewSec: opts.clockSkewSec,
      }),
    );
    return { app, clock };
  }

  // jose's exp check is `exp <= now - tolerance` (jwt_claims_set.js:89), so the
  // boundary itself is treated as expired. The valid edge is `exp = now − skew + 1`.
  // This is asymmetric with the nbf boundary (C2), where strict `>` keeps the
  // boundary valid. See DEVIATIONS.md.
  it('C1: exp boundary — exp = now − skew + 1 valid; exp = now − skew expired', async () => {
    {
      const { app, clock } = exec({ clockSkewSec: 60 });
      const token = await signWithKey(key.privateKey, key.kid, {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: 'u',
        exp: nowSec(clock.now()) - 59,
        iat: nowSec(clock.now()) - 7200,
      });
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
    {
      const { app, clock } = exec({ clockSkewSec: 60 });
      const token = await signWithKey(key.privateKey, key.kid, {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: 'u',
        exp: nowSec(clock.now()) - 60,
        iat: nowSec(clock.now()) - 7200,
      });
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('token expired');
    }
  });

  it('C2: nbf boundary — nbf = now + skew valid; nbf = now + skew + 1 not yet valid', async () => {
    {
      const { app, clock } = exec({ clockSkewSec: 60 });
      const token = await signWithKey(key.privateKey, key.kid, {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: 'u',
        exp: nowSec(clock.now()) + 7200,
        nbf: nowSec(clock.now()) + 60,
        iat: nowSec(clock.now()),
      });
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
    {
      const { app, clock } = exec({ clockSkewSec: 60 });
      const token = await signWithKey(key.privateKey, key.kid, {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: 'u',
        exp: nowSec(clock.now()) + 7200,
        nbf: nowSec(clock.now()) + 61,
        iat: nowSec(clock.now()),
      });
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('token not yet valid');
    }
  });

  it('C3: zero-skew baseline — exp 1s past expires', async () => {
    const { app, clock } = exec({ clockSkewSec: 0 });
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'u',
      exp: nowSec(clock.now()) - 1,
      iat: nowSec(clock.now()) - 100,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('token expired');
  });
});
