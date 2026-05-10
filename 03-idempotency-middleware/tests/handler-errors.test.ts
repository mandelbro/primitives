import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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

/**
 * Build an app that lets Express's DEFAULT error handler emit the response on
 * thrown / next(err) errors — which produces a 500. The middleware's status-
 * boundary skip (≥500 not cached) is the mechanism by which "nothing is cached
 * on handler error" holds in practice. This matches the convention that handler
 * exceptions surface as 5xx; user code that re-maps thrown errors to 4xx is
 * responsible for the cacheability tradeoff that follows from doing so.
 */
const buildApp = (
  mw: ReturnType<typeof createIdempotencyMiddleware>,
  handler: (req: Request, res: Response, next: NextFunction) => void,
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
  // No custom error middleware — Express's default error handler emits a 500.
  return app;
};

describe('createIdempotencyMiddleware — handler errors', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = makeMemoryStore();
  });

  // T28: handler throws synchronously → propagated to error handler (default 500);
  // nothing cached (5xx is non-cacheable per the status boundary);
  // a retry with the SAME key + SAME fingerprint runs the handler fresh.
  it('handler throwing synchronously propagates to the error handler; cache untouched; retry runs the handler fresh', async () => {
    let handlerCalls = 0;
    let shouldThrow = true;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        handlerCalls += 1;
        if (shouldThrow) {
          throw new Error('boom');
        }
        res.status(200).json({ ok: true, retry: true });
      },
    );

    const first = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'throw-key')
      .send({ name: 'thing' });

    expect(first.status).toBe(500);
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(0);

    // Now succeed on retry: same key, same body. Handler must run again
    // (fresh cache) — no replay, no 422 mismatch.
    shouldThrow = false;
    const second = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'throw-key')
      .send({ name: 'thing' });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, retry: true });
    expect(handlerCalls).toBe(2);
    expect(second.headers['idempotency-replay']).toBeUndefined();
    // After the successful retry, the cache should hold exactly one entry.
    expect(store.setCalls).toHaveLength(1);
  });

  // T29: handler calls next(err) → propagated; nothing cached; retry runs fresh.
  it('handler calling next(err) propagates to the error handler; cache untouched; retry runs the handler fresh', async () => {
    let handlerCalls = 0;
    let shouldFail = true;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res, next) => {
        handlerCalls += 1;
        if (shouldFail) {
          next(new Error('next-boom'));
          return;
        }
        res.status(200).json({ ok: true, retry: true });
      },
    );

    const first = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'next-err-key')
      .send({ name: 'thing' });

    expect(first.status).toBe(500);
    expect(handlerCalls).toBe(1);
    expect(store.setCalls).toHaveLength(0);

    shouldFail = false;
    const second = await request(app)
      .post('/widgets')
      .set('Idempotency-Key', 'next-err-key')
      .send({ name: 'thing' });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, retry: true });
    expect(handlerCalls).toBe(2);
    expect(second.headers['idempotency-replay']).toBeUndefined();
    expect(store.setCalls).toHaveLength(1);
  });
});
