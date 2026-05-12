import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { defaultOpts, fakeFetcher, fakeNow, mountApp, TEST_JWKS_URI } from './fixtures.js';

// RFC 7235 quoted-string allows arbitrary octets (including DQUOTE and
// BACKSLASH) provided that DQUOTE and BACKSLASH are escaped via quoted-pair
// (`\"` and `\\`). The realm parameter is consumer-controlled via
// jwtAuth({ realm: ... }) and requireScope({ realm: ... }), so unescaped
// `"` or `\` in a realm would otherwise produce a malformed header.
//
// CR/LF/NUL in a realm are header-injection vectors and are rejected at
// validation time, not escaped (see options-validation tests).
describe('WWW-Authenticate quoted-string escaping (finding #7)', () => {
  it('escapes DQUOTE and BACKSLASH in realm for the 401 missing-creds challenge', async () => {
    const fetcher = fakeFetcher();
    const clock = fakeNow();
    // realm value (decoded): a"b\c — one DQUOTE and one BACKSLASH.
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, realm: 'a"b\\c' }),
    );

    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    // After escaping: a\"b\\c. After wrapping in DQUOTEs in the header
    // value: "a\"b\\c". The full header is: Bearer realm="a\"b\\c"
    expect(res.headers['www-authenticate']).toBe('Bearer realm="a\\"b\\\\c"');
  });

  it('escapes DQUOTE in realm even when an error envelope is present', async () => {
    const fetcher = fakeFetcher();
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, realm: 'has"quote' }),
    );

    // Trigger a structured 401 (Basic scheme → invalid_request).
    const res = await request(app).get('/protected').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer realm="has\\"quote", error="invalid_request", error_description="expected Bearer scheme"',
    );
  });

  it('does not alter a realm with no special characters', async () => {
    const fetcher = fakeFetcher();
    const clock = fakeNow();
    const app = mountApp(
      defaultOpts({ fetcher: fetcher.fetcher, now: clock.now, realm: 'tenant-x' }),
    );
    void TEST_JWKS_URI;

    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="tenant-x"');
  });
});
