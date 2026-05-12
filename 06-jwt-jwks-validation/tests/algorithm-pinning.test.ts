import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import {
  defaultOpts,
  fakeFetcher,
  fakeNow,
  generateTestKeyPair,
  jwks,
  type KeyMaterial,
  mountApp,
  nowSec,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_JWKS_URI,
} from './fixtures.js';

// Bypass src/decode-header.ts's pre-decode alg rejection to isolate the
// jose-side defense. The §1 "belt" (the pre-decode RS256 hard-pin) is
// stubbed; the only thing standing between us and RSA-family algorithm
// confusion is the §1 "suspenders": the `algorithms: ['RS256']` argument
// passed to jose.jwtVerify in src/jwt-auth.ts.
//
// Empirically verified by mutation: removing that argument causes this
// test to fail because jose v5 will happily verify an RS384 signature
// using a CryptoKey imported as RS256 — the WebCrypto algorithm binding
// is NOT a structural defense here. The `algorithms` arg is the actual
// security control, not redundant defense-in-depth.
vi.mock('../src/decode-header.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/decode-header.js')>();
  return {
    ...actual,
    decodeHeader: vi.fn(),
  };
});

const { decodeHeader } = await import('../src/decode-header.js');
const decodeHeaderMock = decodeHeader as unknown as ReturnType<typeof vi.fn>;

describe('B2: jose-side RS256 hard-pin (suspenders half of §1)', () => {
  let key: KeyMaterial;
  const KID = 'kid-good';

  beforeAll(async () => {
    key = await generateTestKeyPair(KID);
  });

  beforeEach(() => {
    // Lie to the pipeline: claim the header is well-formed RS256 even
    // when the token is actually signed with a different RSA algorithm.
    decodeHeaderMock.mockReturnValue({ alg: 'RS256', kid: KID });
  });

  it('rejects an RS384-signed JWT — pins the algorithms: ["RS256"] argument', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, clockSkewSec: 0 }),
    );

    // Same RSA private key, different hash. The JWKS publishes the public
    // key with alg=RS256 and the cache imports it as RS256. The JWT's
    // protected header literally says alg=RS384; only the mocked
    // decodeHeader lies about that to the pipeline. jose re-parses the
    // header during verify and the algorithms gate must reject it BEFORE
    // signature verification — otherwise jose accepts the RS384 signature
    // against the RS256-imported key and the request returns 200.
    const token = await new SignJWT({
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'user-1',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    })
      .setProtectedHeader({ alg: 'RS384', kid: KID })
      .sign(key.privateKey);

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    // jose throws JOSEAlgNotAllowed at the algorithms gate, which falls
    // through mapJoseError to "malformed". The 401 is the security
    // property; the exact label pins the path through mapJoseError.
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer realm="api", error="invalid_token", error_description="malformed"',
    );
    expect(res.body).not.toHaveProperty('auth');
  });
});
