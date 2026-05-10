import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import {
  craftRawJwt,
  craftTwoSegmentJwt,
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

interface AuthChallenge {
  scheme: string;
  realm?: string;
  error?: string;
  errorDescription?: string;
}

function parseChallenge(header: string | undefined): AuthChallenge {
  if (!header) return { scheme: '' };
  const [scheme, ...rest] = header.split(' ');
  const params = rest.join(' ').split(',').map((p) => p.trim());
  const out: AuthChallenge = { scheme: scheme ?? '' };
  for (const p of params) {
    const m = p.match(/^([a-zA-Z_]+)="(.*)"$/u);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!;
    if (key === 'realm') out.realm = val;
    if (key === 'error') out.error = val;
    if (key === 'error_description') out.errorDescription = val;
  }
  return out;
}

describe('wire-format envelope coverage (A3)', () => {
  let key: KeyMaterial;
  let key2: KeyMaterial;

  beforeAll(async () => {
    key = await generateTestKeyPair('kid-good');
    key2 = await generateTestKeyPair('kid-other');
  });

  async function exec(buildAuthHeader: () => Promise<string>): Promise<{
    status: number;
    challenge: AuthChallenge;
  }> {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({
        fetcher: fetcher.fetcher,
        now: clock.now,
        clockSkewSec: 0,
      }),
    );
    const auth = await buildAuthHeader();
    const res = await request(app).get('/protected').set('Authorization', auth);
    return {
      status: res.status,
      challenge: parseChallenge(res.headers['www-authenticate']),
    };
  }

  function validClaims(clockMs: number): Parameters<typeof signWithKey>[2] {
    return {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'user-1',
      exp: nowSec(clockMs) + 3600,
      iat: nowSec(clockMs),
    };
  }

  it.each<{
    name: string;
    build: () => Promise<string>;
    expected: { error: string; description: string };
  }>([
    {
      name: 'non-Bearer scheme',
      build: async () => 'Basic abc',
      expected: { error: 'invalid_request', description: 'expected Bearer scheme' },
    },
    {
      name: 'empty Bearer payload',
      build: async () => 'Bearer ',
      expected: { error: 'invalid_token', description: 'malformed' },
    },
    {
      name: 'extra parts after Bearer',
      build: async () => 'Bearer foo bar',
      expected: { error: 'invalid_token', description: 'malformed' },
    },
    {
      name: 'two-segment JWT',
      build: async () =>
        `Bearer ${craftTwoSegmentJwt({ alg: 'RS256', kid: 'kid-good' }, { sub: 'x' })}`,
      expected: { error: 'invalid_token', description: 'malformed' },
    },
    {
      name: 'non-base64 segment',
      build: async () => 'Bearer !!!.@@@.###',
      expected: { error: 'invalid_token', description: 'malformed' },
    },
    {
      name: 'header alg=none',
      build: async () =>
        `Bearer ${craftRawJwt({ alg: 'none', kid: 'kid-good' }, { sub: 'x' }, '')}`,
      expected: { error: 'invalid_token', description: 'unsupported alg' },
    },
    {
      name: 'header alg=HS256',
      build: async () =>
        `Bearer ${craftRawJwt({ alg: 'HS256', kid: 'kid-good' }, { sub: 'x' }, 'sig')}`,
      expected: { error: 'invalid_token', description: 'unsupported alg' },
    },
    {
      name: 'header missing kid',
      build: async () => `Bearer ${craftRawJwt({ alg: 'RS256' }, { sub: 'x' }, 'sig')}`,
      expected: { error: 'invalid_token', description: 'unknown kid' },
    },
  ])('$name → $expected.error / $expected.description', async ({ build, expected }) => {
    const res = await exec(build);
    expect(res.status).toBe(401);
    expect(res.challenge.error).toBe(expected.error);
    expect(res.challenge.errorDescription).toBe(expected.description);
  });

  // Cases that need real RS256 signatures or the real cache.
  it('unknown kid after refresh → unknown kid', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    // Use a token with a kid that the JWKS does not advertise — sign with key2,
    // but the JWKS only publishes key1.
    const token = await signWithKey(key2.privateKey, key2.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.error).toBe('invalid_token');
    expect(challenge.errorDescription).toBe('unknown kid');
  });

  it('tampered signature → invalid signature', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    const token = await signWithKey(key.privateKey, key.kid, validClaims(clock.now()));
    // Flip a char in the middle of the signature segment. Tampering the
    // trailing chars is unreliable because base64url's "extra bits" can be
    // discarded during decode, leaving the byte sequence unchanged.
    const segments = token.split('.');
    const sig = segments[2]!;
    const mid = Math.floor(sig.length / 2);
    const target = sig[mid]!;
    const flipped = sig.slice(0, mid) + (target === 'A' ? 'B' : 'A') + sig.slice(mid + 1);
    const tampered = `${segments[0]}.${segments[1]}.${flipped}`;
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${tampered}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.error).toBe('invalid_token');
    expect(challenge.errorDescription).toBe('invalid signature');
  });

  it('wrong-key signature for declared kid → invalid signature', async () => {
    // JWKS says kid-good is key1's public key; but we sign with key2 and CLAIM kid-good.
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    const token = await signWithKey(key2.privateKey, key.kid, validClaims(clock.now()));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.error).toBe('invalid_token');
    expect(challenge.errorDescription).toBe('invalid signature');
  });

  it('expired exp → token expired', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'user-1',
      exp: nowSec(clock.now()) - 1,
      iat: nowSec(clock.now()) - 3600,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.errorDescription).toBe('token expired');
  });

  it('future nbf → token not yet valid', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'user-1',
      exp: nowSec(clock.now()) + 3600,
      nbf: nowSec(clock.now()) + 60,
      iat: nowSec(clock.now()),
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.errorDescription).toBe('token not yet valid');
  });

  it('wrong issuer → invalid issuer', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: 'https://attacker.example/',
      aud: TEST_AUDIENCE,
      sub: 'user-1',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.errorDescription).toBe('invalid issuer');
  });

  it('wrong audience → invalid audience', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );
    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: 'urn:other:api',
      sub: 'user-1',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const challenge = parseChallenge(res.headers['www-authenticate']);
    expect(res.status).toBe(401);
    expect(challenge.errorDescription).toBe('invalid audience');
  });
});
