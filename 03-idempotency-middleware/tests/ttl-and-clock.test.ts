import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import {
  createIdempotencyMiddleware,
  type CachedResponse,
  type Store,
} from '../src/index.js';

/**
 * TTL-honoring in-memory store. Implements the contract from the spec:
 * "MUST return null when storedAt + ttlMs < now". Records every get's now
 * argument so T31 can assert the middleware threads its clock through.
 */
interface TtlStore extends Store {
  readonly getCalls: Array<{ key: string; now: number }>;
  readonly setCalls: Array<{ key: string; value: CachedResponse; ttlMs: number }>;
}

const makeTtlStore = (): TtlStore => {
  const map = new Map<string, { value: CachedResponse; expiresAt: number }>();
  const getCalls: TtlStore['getCalls'] = [];
  const setCalls: TtlStore['setCalls'] = [];
  return {
    getCalls,
    setCalls,
    async get(key, now) {
      getCalls.push({ key, now });
      const entry = map.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAt < now) return null;
      return entry.value;
    },
    async set(key, value, ttlMs) {
      setCalls.push({ key, value, ttlMs });
      map.set(key, { value, expiresAt: value.storedAt + ttlMs });
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

describe('createIdempotencyMiddleware — TTL & clock', () => {
  let store: TtlStore;

  beforeEach(() => {
    store = makeTtlStore();
  });

  // T30: After the TTL window passes, the cached entry is treated as expired:
  // the handler runs again, and the new response overwrites the stale entry.
  it('after the clock advances past storedAt + ttlMs, the same key is treated as a cache miss; handler re-runs and the entry is overwritten', async () => {
    let nowMs = 1_000_000;
    const clock = () => nowMs;
    const ttlMs = 5_000;

    let handlerCalls = 0;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g', ttlMs, clock }),
      (_req, res) => {
        handlerCalls += 1;
        res.status(200).json({ call: handlerCalls });
      },
    );

    // First call at t=1_000_000: handler runs, entry stored with
    // storedAt=1_000_000 and expiresAt=1_005_000.
    const first = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'ttl-key')
      .send({});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ call: 1 });
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(1);
    expect(store.setCalls[0]!.value.storedAt).toBe(1_000_000);
    expect(store.setCalls[0]!.ttlMs).toBe(ttlMs);

    // Advance just past the TTL window. expiresAt is 1_005_000 (storedAt + ttlMs);
    // store.get returns null when expiresAt < now, so 1_005_001 is the first
    // moment the entry is considered expired.
    nowMs = 1_005_001;

    const second = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'ttl-key')
      .send({});

    // Cache miss → handler ran fresh, returned its second-call body.
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ call: 2 });
    expect(second.headers['idempotency-replay']).toBeUndefined();
    expect(handlerCalls).toBe(2);

    // Cache was overwritten with the new entry stamped at the new clock.
    expect(store.setCalls).toHaveLength(2);
    expect(store.setCalls[1]!.value.storedAt).toBe(1_005_001);
    expect(store.setCalls[1]!.ttlMs).toBe(ttlMs);
  });

  // T31: middleware passes clock()'s value as the `now` argument to store.get
  // on EVERY lookup, not just the first.
  it("middleware threads clock()'s value to store.get on every lookup", async () => {
    let nowMs = 2_000_000;
    const clock = () => nowMs;

    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g', clock }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    // First request observes nowMs = 2_000_000.
    await request(app)
      .post('/x')
      .set('Idempotency-Key', 'clock-key')
      .send({});

    // Advance the clock and issue a different key so we exercise a SECOND
    // lookup (the same key would be a cache hit but still trigger a get).
    nowMs = 2_000_500;
    await request(app)
      .post('/x')
      .set('Idempotency-Key', 'clock-key-2')
      .send({});

    // Both lookups received the clock's reading at call time.
    expect(store.getCalls).toHaveLength(2);
    expect(store.getCalls[0]!.now).toBe(2_000_000);
    expect(store.getCalls[1]!.now).toBe(2_000_500);
  });
});
