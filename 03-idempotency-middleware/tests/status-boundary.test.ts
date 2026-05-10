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
  app.post('/x', handler);
  return app;
};

describe('createIdempotencyMiddleware — status caching boundary (200 ≤ status < 500)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = makeMemoryStore();
  });

  // T32–T35: 200, 301, 404, 422 are all in the cacheable range — first call
  // populates the cache, retry replays. Status-specific notes captured per case.
  describe.each([
    { tid: 'T32', status: 200, note: 'success' },
    { tid: 'T33', status: 301, note: 'deterministic redirect' },
    { tid: 'T34', status: 404, note: 'not found' },
    { tid: 'T35', status: 422, note: 'validation error' },
  ])('$tid — $status ($note) is cacheable', ({ status }) => {
    it(`first call returns ${status}, retry replays from cache (handler not re-invoked)`, async () => {
      let handlerCalls = 0;
      const app = buildApp(
        createIdempotencyMiddleware({ store, scope: () => 'g' }),
        (_req, res) => {
          handlerCalls += 1;
          res.status(status).json({ status, call: handlerCalls });
        },
      );

      const first = await request(app)
        .post('/x')
        .set('Idempotency-Key', `cacheable-${status}`)
        .send({ s: status });
      expect(first.status).toBe(status);
      expect(first.body).toEqual({ status, call: 1 });
      expect(handlerCalls).toBe(1);
      expect(store.setCalls).toHaveLength(1);

      const second = await request(app)
        .post('/x')
        .set('Idempotency-Key', `cacheable-${status}`)
        .send({ s: status });
      expect(second.status).toBe(status);
      // Body matches the first call exactly — proves replay, not a fresh
      // handler invocation that would yield { call: 2 }.
      expect(second.body).toEqual({ status, call: 1 });
      expect(handlerCalls).toBe(1);
      expect(second.headers['idempotency-replay']).toBe('true');
      // Cache was not overwritten — still exactly one set call.
      expect(store.setCalls).toHaveLength(1);
    });
  });

  // T36–T37: 500, 503 are NOT in the cacheable range — first call is not
  // stored, retry runs the handler fresh.
  describe.each([
    { tid: 'T36', status: 500, note: 'internal server error' },
    { tid: 'T37', status: 503, note: 'service unavailable' },
  ])('$tid — $status ($note) is NOT cacheable', ({ status }) => {
    it(`first call returns ${status}, store untouched, retry re-invokes the handler`, async () => {
      let handlerCalls = 0;
      const app = buildApp(
        createIdempotencyMiddleware({ store, scope: () => 'g' }),
        (_req, res) => {
          handlerCalls += 1;
          res.status(status).json({ status, call: handlerCalls });
        },
      );

      const first = await request(app)
        .post('/x')
        .set('Idempotency-Key', `transient-${status}`)
        .send({ s: status });
      expect(first.status).toBe(status);
      expect(first.body).toEqual({ status, call: 1 });
      expect(handlerCalls).toBe(1);
      expect(store.setCalls).toHaveLength(0);

      const second = await request(app)
        .post('/x')
        .set('Idempotency-Key', `transient-${status}`)
        .send({ s: status });
      expect(second.status).toBe(status);
      expect(second.body).toEqual({ status, call: 2 });
      expect(handlerCalls).toBe(2);
      expect(second.headers['idempotency-replay']).toBeUndefined();
      expect(store.setCalls).toHaveLength(0);
    });
  });

  // T38: the natural transient-then-success sequence. First attempt 503
  // (not cached) → retry runs the handler, which now succeeds with 200
  // (cached) → second retry replays the 200.
  it('T38 — composite 503 → 200 → replayed 200 (transient failure followed by recovery)', async () => {
    let handlerCalls = 0;
    let mode: 503 | 200 = 503;

    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        handlerCalls += 1;
        res.status(mode).json({ mode, call: handlerCalls });
      },
    );

    // Attempt 1: handler returns 503 (transient failure).
    const a1 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'composite-key')
      .send({ v: 1 });
    expect(a1.status).toBe(503);
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(0);

    // Attempt 2: handler now returns 200 (recovered) — cache miss because the
    // 503 was never stored, so the handler runs and the 200 is cached.
    mode = 200;
    const a2 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'composite-key')
      .send({ v: 1 });
    expect(a2.status).toBe(200);
    expect(a2.body).toEqual({ mode: 200, call: 2 });
    expect(handlerCalls).toBe(2);
    expect(a2.headers['idempotency-replay']).toBeUndefined();
    expect(store.setCalls).toHaveLength(1);

    // Attempt 3: same key, handler now WOULD return something else if invoked,
    // but the cached 200 should replay.
    mode = 503; // sentinel — if the handler runs, we'd see 503 + call:3
    const a3 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'composite-key')
      .send({ v: 1 });
    expect(a3.status).toBe(200);
    expect(a3.body).toEqual({ mode: 200, call: 2 });
    expect(handlerCalls).toBe(2);
    expect(a3.headers['idempotency-replay']).toBe('true');
    // Still exactly one set call — replay does not write.
    expect(store.setCalls).toHaveLength(1);
  });
});
