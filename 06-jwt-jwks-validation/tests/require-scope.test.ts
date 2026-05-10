import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { jwtAuth } from '../src/jwt-auth.js';
import { requireScope } from '../src/require-scope.js';
import {
  defaultOpts,
  fakeFetcher,
  fakeNow,
  generateTestKeyPair,
  jwks,
  type KeyMaterial,
  nowSec,
  signWithKey,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_JWKS_URI,
} from './fixtures.js';

describe('requireScope (F1, F2)', () => {
  let key: KeyMaterial;

  beforeAll(async () => {
    key = await generateTestKeyPair('kid-1');
  });

  function buildApp(opts: { tokenScope: string }) {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();
    const app = express();
    const auth = jwtAuth(defaultOpts({ fetcher: fetcher.fetcher, now: clock.now }));
    app.get('/admin', auth, requireScope('admin'), (_req, res) => res.json({ ok: true }));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    return { app, clock, fetcher, sign: (scopeClaim?: string) =>
      signWithKey(key.privateKey, key.kid, {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: 'u',
        exp: nowSec(clock.now()) + 3600,
        iat: nowSec(clock.now()),
        ...(scopeClaim !== undefined ? { scope: scopeClaim } : {}),
      }),
    };
  }

  it('F1: required scope present → 200', async () => {
    const t = buildApp({ tokenScope: 'admin' });
    const token = await t.sign('admin read');
    const res = await request(t.app).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('F2: required scope absent → 403 insufficient_scope "requires admin"', async () => {
    const t = buildApp({ tokenScope: 'read' });
    const token = await t.sign('read');
    const res = await request(t.app).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(res.headers['www-authenticate']).toContain('error_description="requires admin"');
  });

  it('F2: token with no scope claim at all → 403', async () => {
    const t = buildApp({ tokenScope: '' });
    const token = await t.sign(); // no scope
    const res = await request(t.app).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
  });
});

describe('wiring errors (G1, G2)', () => {
  let key: KeyMaterial;

  beforeAll(async () => {
    key = await generateTestKeyPair('kid-1');
  });

  it('G1: requireScope without jwtAuth upstream throws', async () => {
    const app = express();
    app.get('/admin', requireScope('admin'), (_req, res) => res.json({ ok: true }));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    const res = await request(app).get('/admin');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/req\.auth is not set/);
  });

  it('G2: jwtAuth runs against a request where req.auth is already set → throws', async () => {
    const fetcher = fakeFetcher();
    fetcher.enqueue(TEST_JWKS_URI, { body: jwks([key.publicJwk]) });
    const clock = fakeNow();

    const app = express();
    // Pre-populate req.auth before jwtAuth runs.
    app.use((req, _res, next) => {
      req.auth = { sub: 'spoofed', scope: [], claims: {} };
      next();
    });
    app.get(
      '/protected',
      jwtAuth(defaultOpts({ fetcher: fetcher.fetcher, now: clock.now })),
      (_req, res) => res.json({ ok: true }),
    );
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const token = await signWithKey(key.privateKey, key.kid, {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: 'u',
      exp: nowSec(clock.now()) + 3600,
      iat: nowSec(clock.now()),
    });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/req\.auth is already set/);
  });
});
