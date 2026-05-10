import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import {
  createIdempotencyMiddleware,
  type CachedResponse,
  type Store,
} from '../src/index.js';

interface SpyStore extends Store {
  readonly getCalls: Array<{ key: string; now: number }>;
  readonly setCalls: Array<{ key: string; value: CachedResponse; ttlMs: number }>;
}

const makeSpyStore = (
  initial: Map<string, CachedResponse> = new Map(),
): SpyStore => {
  const getCalls: SpyStore['getCalls'] = [];
  const setCalls: SpyStore['setCalls'] = [];
  return {
    getCalls,
    setCalls,
    async get(key, now) {
      getCalls.push({ key, now });
      return initial.get(key) ?? null;
    },
    async set(key, value, ttlMs) {
      setCalls.push({ key, value, ttlMs });
      initial.set(key, value);
    },
  };
};

const buildApp = (
  mw: ReturnType<typeof createIdempotencyMiddleware>,
  handlerCalls: { count: number },
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
  const handler = (_req: express.Request, res: express.Response) => {
    handlerCalls.count += 1;
    res.status(200).json({ ok: true });
  };
  app.post('/x', handler);
  app.put('/x', handler);
  app.get('/x', handler);
  app.head('/x', handler);
  return app;
};

describe('createIdempotencyMiddleware — passthrough behavior', () => {
  let store: SpyStore;
  let handlerCalls: { count: number };

  beforeEach(() => {
    store = makeSpyStore();
    handlerCalls = { count: 0 };
  });

  // T6
  it('tracked verb (POST) with no Idempotency-Key passes through; store untouched', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'global' }),
      handlerCalls,
    );

    const res = await request(app).post('/x').send({ v: 1 });

    expect(res.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
    expect(store.getCalls).toHaveLength(0);
    expect(store.setCalls).toHaveLength(0);
  });

  // T7
  it('tracked verb with whitespace-only Idempotency-Key passes through (treated as absent)', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'global' }),
      handlerCalls,
    );

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', '   \t  ')
      .send({ v: 1 });

    expect(res.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
    expect(store.getCalls).toHaveLength(0);
    expect(store.setCalls).toHaveLength(0);
  });

  // T8
  it('untracked verb (GET) with Idempotency-Key passes through', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'global' }),
      handlerCalls,
    );

    const res = await request(app).get('/x').set('Idempotency-Key', 'abc-123');

    expect(res.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
    expect(store.getCalls).toHaveLength(0);
    expect(store.setCalls).toHaveLength(0);
  });

  // T9
  it('untracked verb (HEAD) with Idempotency-Key passes through', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'global' }),
      handlerCalls,
    );

    const res = await request(app).head('/x').set('Idempotency-Key', 'abc-123');

    expect(res.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
    expect(store.getCalls).toHaveLength(0);
    expect(store.setCalls).toHaveLength(0);
  });

  // T10
  it("custom trackedMethods: new Set(['post']) (lowercase) tracks POST after construction-time normalization", async () => {
    const app = buildApp(
      createIdempotencyMiddleware({
        store,
        scope: () => 'global',
        trackedMethods: new Set(['post']),
      }),
      handlerCalls,
    );

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'lower-tracked-key')
      .send({ v: 1 });

    expect(res.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
    // Tracked verb => store IS consulted (cache lookup) on the first call.
    // The store.set side (response capture) belongs to Batch 3.
    expect(store.getCalls).toHaveLength(1);

    // Untracked verbs (PUT not in the custom set) must still bypass entirely.
    handlerCalls.count = 0;
    store.getCalls.length = 0;
    const putRes = await request(app)
      .put('/x')
      .set('Idempotency-Key', 'lower-tracked-key')
      .send({ v: 1 });
    expect(putRes.status).toBe(200);
    expect(handlerCalls.count).toBe(1);
    expect(store.getCalls).toHaveLength(0);
  });

  // T11 moved to Batch 3 (first write & cache mechanics) — it asserts on
  // store.setCalls which requires response-capture machinery that lives there.
});
