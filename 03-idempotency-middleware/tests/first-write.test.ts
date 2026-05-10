import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import {
  createIdempotencyMiddleware,
  type CachedResponse,
  type Store,
} from '../src/index.js';

interface SpyStore extends Store {
  readonly setCalls: Array<{
    key: string;
    value: CachedResponse;
    ttlMs: number;
  }>;
}

const makeSpyStore = (): SpyStore => {
  const setCalls: SpyStore['setCalls'] = [];
  return {
    setCalls,
    async get() {
      return null;
    },
    async set(key, value, ttlMs) {
      setCalls.push({ key, value, ttlMs });
    },
  };
};

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;

const buildApp = (
  mw: ReturnType<typeof createIdempotencyMiddleware>,
  handler: (req: Request, res: Response) => void,
): Express => {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(mw);
  app.post('/widgets', handler);
  app.put('/widgets/:id', handler);
  return app;
};

const sha256Hex = (parts: Array<string | Uint8Array>): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

describe('createIdempotencyMiddleware — first write & cache mechanics', () => {
  let store: SpyStore;

  beforeEach(() => {
    store = makeSpyStore();
  });

  // T11 (moved from Batch 2)
  it('Idempotency-Key value with leading/trailing whitespace is trimmed before forming the cache key', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({
        store,
        scope: () => 'tenant-1',
        clock: fixedClock,
      }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const res = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', '   key-with-spaces   ')
      .send({ v: 1 });

    expect(res.status).toBe(200);
    expect(store.setCalls).toHaveLength(1);
    expect(store.setCalls[0]?.key).toBe('tenant-1:key-with-spaces');
  });

  // T12
  it('first write executes handler, returns result, populates cache with exact status/headers/body', async () => {
    let handlerCalls = 0;
    const app = buildApp(
      createIdempotencyMiddleware({
        store,
        scope: () => 'global',
        clock: fixedClock,
      }),
      (_req, res) => {
        handlerCalls += 1;
        res
          .status(201)
          .set('X-Custom', 'hello')
          .json({ created: true, id: 42 });
      },
    );

    const res = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'first-write-key')
      .send({ name: 'gizmo' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: true, id: 42 });
    expect(handlerCalls).toBe(1);

    expect(store.setCalls).toHaveLength(1);
    const entry = store.setCalls[0];
    expect(entry).toBeDefined();
    expect(entry!.value.status).toBe(201);

    const headers = entry!.value.headers;
    // Express normalizes header names to lower-case in res.getHeaders().
    const headerLookup = (name: string): string | string[] | undefined => {
      const direct = headers[name];
      if (direct !== undefined) return direct;
      const lower = headers[name.toLowerCase()];
      return lower;
    };
    expect(headerLookup('X-Custom')).toBe('hello');
    expect(String(headerLookup('Content-Type') ?? '')).toContain('application/json');

    // Body bytes are exactly what went over the wire (not what we'd get from a
    // fresh JSON.stringify — Express may apply json-spaces formatting per env).
    expect(Buffer.from(entry!.value.body).toString('utf8')).toBe(res.text);
  });

  // T13
  it("cache entry's fingerprint is SHA-256(`${method}\\n${originalUrl}\\n` + raw body bytes), hex, length 64", async () => {
    const bodyJson = JSON.stringify({ name: 'thing', value: 99 });
    const app = buildApp(
      createIdempotencyMiddleware({
        store,
        scope: () => 'global',
        clock: fixedClock,
      }),
      (_req, res) => {
        res.status(200).send('ok');
      },
    );

    const res = await request(app)
      .post('/widgets?force=1')
      .set('Idempotency-Key', 'fingerprint-key')
      .set('Content-Type', 'application/json')
      .send(bodyJson);

    expect(res.status).toBe(200);
    expect(store.setCalls).toHaveLength(1);
    const fingerprint = store.setCalls[0]!.value.fingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const expected = sha256Hex([
      'POST\n',
      '/widgets?force=1\n',
      Buffer.from(bodyJson),
    ]);
    expect(fingerprint).toBe(expected);
  });

  // T14
  it("cache entry's storedAt equals the injected clock's value at the moment of write", async () => {
    const app = buildApp(
      createIdempotencyMiddleware({
        store,
        scope: () => 'global',
        clock: fixedClock,
      }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const res = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'stored-at-key')
      .send({});

    expect(res.status).toBe(200);
    expect(store.setCalls).toHaveLength(1);
    expect(store.setCalls[0]!.value.storedAt).toBe(FIXED_NOW);
  });

  // T15
  it('cache key is `${scope(req)}:${idempotencyKey}` — scope prefix + colon + trimmed key', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({
        store,
        scope: (req) => {
          const tid = req.headers['x-tenant'];
          return typeof tid === 'string' ? tid : 'unknown';
        },
        clock: fixedClock,
      }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const res = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'plain-key')
      .set('X-Tenant', 'acme-corp')
      .send({});

    expect(res.status).toBe(200);
    expect(store.setCalls).toHaveLength(1);
    expect(store.setCalls[0]!.key).toBe('acme-corp:plain-key');
  });
});
