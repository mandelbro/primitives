import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import {
  createIdempotencyMiddleware,
  type CachedResponse,
  type Store,
} from '../src/index.js';

interface MemoryStore extends Store {
  readonly setCalls: Array<{ key: string; value: CachedResponse; ttlMs: number }>;
}

const makeMemoryStore = (): MemoryStore => {
  const map = new Map<string, CachedResponse>();
  const setCalls: MemoryStore['setCalls'] = [];
  return {
    setCalls,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value, ttlMs) {
      setCalls.push({ key, value, ttlMs });
      map.set(key, value);
    },
  };
};

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
  return app;
};

describe('createIdempotencyMiddleware — fingerprint mismatch (422)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = makeMemoryStore();
  });

  // T25: same key + different body bytes → 422; handler NOT called; cache NOT overwritten.
  it("same key with different body bytes returns 422 fingerprint_mismatch envelope; handler isn't called and the cached entry is preserved", async () => {
    let handlerCalls = 0;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        handlerCalls += 1;
        res.status(201).json({ id: 7, name: 'first' });
      },
    );

    // Seed the cache with the first request body.
    const first = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ name: 'first' });
    expect(first.status).toBe(201);
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(1);

    // Same key, DIFFERENT body — must 422.
    const second = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ name: 'second' });

    expect(second.status).toBe(422);
    expect(String(second.headers['content-type'] ?? '')).toMatch(/^application\/json/);
    expect(second.body).toEqual({
      error: 'fingerprint_mismatch',
      message: 'Idempotency key reused with a different request payload.',
    });

    // Handler must not have re-run; cache must not have been overwritten.
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(1);
  });

  // T26: same key, same method/path, DIFFERENT query string → 422 (originalUrl differs).
  it("same key with a different query string returns 422 (query is part of originalUrl, so fingerprints differ)", async () => {
    let handlerCalls = 0;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        handlerCalls += 1;
        res.status(200).json({ ok: true });
      },
    );

    const first = await request(app)
      .post('/widgets?force=1')
      .set('Idempotency-Key', 'query-key')
      .send({ a: 1 });
    expect(first.status).toBe(200);
    expect(handlerCalls).toBe(1);

    const second = await request(app)
      .post('/widgets?force=2')
      .set('Idempotency-Key', 'query-key')
      .send({ a: 1 });

    expect(second.status).toBe(422);
    expect(second.body).toEqual({
      error: 'fingerprint_mismatch',
      message: 'Idempotency key reused with a different request payload.',
    });
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(1);
  });

  // T27: same key, asymmetric rawBody (defined on first call, undefined on second) → 422.
  it("same key with asymmetric rawBody (defined first, undefined second) returns 422", async () => {
    let handlerCalls = 0;

    // Two app instances share the SAME store but only the first wires rawBody.
    // This isolates the asymmetric-rawBody case the spec calls out.
    const app1 = express();
    app1.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app1.use(createIdempotencyMiddleware({ store, scope: () => 'g' }));
    app1.post('/widgets', (_req, res) => {
      handlerCalls += 1;
      res.status(200).json({ ok: true });
    });

    const app2 = express();
    // No express.json + verify wiring → req.rawBody stays undefined on the retry.
    app2.use(createIdempotencyMiddleware({ store, scope: () => 'g' }));
    app2.post('/widgets', (_req, res) => {
      handlerCalls += 1;
      res.status(200).json({ ok: true });
    });

    const first = await request(app1)
      .post('/widgets')
      .set('Idempotency-Key', 'asym-key')
      .send({ name: 'thing' });
    expect(first.status).toBe(200);
    expect(handlerCalls).toBe(1);

    const second = await request(app2)
      .post('/widgets')
      .set('Idempotency-Key', 'asym-key')
      .set('Content-Type', 'application/json')
      .send({ name: 'thing' });

    expect(second.status).toBe(422);
    expect(second.body).toEqual({
      error: 'fingerprint_mismatch',
      message: 'Idempotency key reused with a different request payload.',
    });
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(1);
  });
});
