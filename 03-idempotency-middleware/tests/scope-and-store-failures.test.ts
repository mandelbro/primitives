import { describe, it, expect, beforeEach } from 'vitest';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
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

describe('createIdempotencyMiddleware — scope isolation', () => {
  // T39: same idempotency key sent under two different scopes resolves to two
  // distinct cache entries; replaying tenant A's key returns A's response, not
  // B's. The scope function is the security boundary that prevents cross-tenant
  // collisions.
  it('T39 — same key under different scopes does not collide; each tenant replays its own response', async () => {
    const store = makeMemoryStore();
    let handlerCalls = 0;

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use(
      createIdempotencyMiddleware({
        store,
        scope: (req) => {
          const t = req.headers['x-tenant'];
          return typeof t === 'string' ? t : 'unknown';
        },
      }),
    );
    app.post('/x', (req, res) => {
      handlerCalls += 1;
      const tenant =
        typeof req.headers['x-tenant'] === 'string' ? req.headers['x-tenant'] : 'unknown';
      res.status(200).json({ tenant, secret: `${tenant}-secret-payload` });
    });

    // First call from tenant-a — handler runs, stores under "tenant-a:shared-key".
    const a1 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'shared-key')
      .set('X-Tenant', 'tenant-a')
      .send({ same: 'body' });
    expect(a1.status).toBe(200);
    expect(a1.body).toEqual({ tenant: 'tenant-a', secret: 'tenant-a-secret-payload' });

    // First call from tenant-b — same key + same body, but different scope.
    // Must NOT replay tenant-a's response; handler runs again under "tenant-b:shared-key".
    const b1 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'shared-key')
      .set('X-Tenant', 'tenant-b')
      .send({ same: 'body' });
    expect(b1.status).toBe(200);
    expect(b1.body).toEqual({ tenant: 'tenant-b', secret: 'tenant-b-secret-payload' });
    expect(b1.headers['idempotency-replay']).toBeUndefined();
    expect(handlerCalls).toBe(2);

    // Cache now holds two distinct entries under different scope prefixes.
    expect(store.setCalls).toHaveLength(2);
    expect(store.setCalls.map((c) => c.key).sort()).toEqual([
      'tenant-a:shared-key',
      'tenant-b:shared-key',
    ]);

    // Tenant A retry replays A's response (NOT B's) — the security invariant.
    const a2 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'shared-key')
      .set('X-Tenant', 'tenant-a')
      .send({ same: 'body' });
    expect(a2.status).toBe(200);
    expect(a2.body).toEqual({ tenant: 'tenant-a', secret: 'tenant-a-secret-payload' });
    expect(a2.headers['idempotency-replay']).toBe('true');
    expect(handlerCalls).toBe(2);

    // Tenant B retry replays B's response (NOT A's).
    const b2 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'shared-key')
      .set('X-Tenant', 'tenant-b')
      .send({ same: 'body' });
    expect(b2.status).toBe(200);
    expect(b2.body).toEqual({ tenant: 'tenant-b', secret: 'tenant-b-secret-payload' });
    expect(b2.headers['idempotency-replay']).toBe('true');
    expect(handlerCalls).toBe(2);
  });
});

describe('createIdempotencyMiddleware — store failure propagation', () => {
  // T40: store.get rejection is forwarded via next(err); handler is NOT called.
  // The error reaches the app's error middleware, which gets to decide how to
  // surface it.
  it('T40 — store.get rejection forwards via next(err); handler is not invoked', async () => {
    let handlerCalls = 0;
    const trapped: unknown[] = [];

    const failingStore: Store = {
      async get() {
        throw new Error('get-failed');
      },
      async set() {
        // unreachable in this test
      },
    };

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use(createIdempotencyMiddleware({ store: failingStore, scope: () => 'g' }));
    app.post('/x', (_req, res) => {
      handlerCalls += 1;
      res.status(200).json({ ok: true });
    });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      trapped.push(err);
      if (!res.headersSent) {
        res.status(599).json({ trapped: true });
      }
    });

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'get-fail-key')
      .send({});

    // Error middleware fired with the store's rejection; it returned 599.
    expect(res.status).toBe(599);
    expect(res.body).toEqual({ trapped: true });
    expect(trapped).toHaveLength(1);
    expect((trapped[0] as Error).message).toBe('get-failed');
    // Handler MUST NOT have been called: the cache lookup failed, so we never
    // reached the cache-miss branch that calls next() into the handler.
    expect(handlerCalls).toBe(0);
  });

  // T41: store.set rejection happens AFTER the response was sent (the cache
  // write fires from the res 'finish' listener). The middleware forwards the
  // rejection via next(err), where it reaches the app's error middleware —
  // which can observe (e.g., log) but cannot respond. The next retry sees a
  // cache miss because the rejected set never persisted anything, so the
  // handler runs again fresh.
  it('T41 — store.set rejection forwards via next(err) post-response; retry sees a cache miss', async () => {
    let handlerCalls = 0;
    const trapped: unknown[] = [];
    const setCalls: Array<{ key: string }> = [];

    const failingSetStore: Store = {
      async get() {
        return null;
      },
      async set(key) {
        setCalls.push({ key });
        throw new Error('set-failed');
      },
    };

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use(createIdempotencyMiddleware({ store: failingSetStore, scope: () => 'g' }));
    app.post('/x', (_req, res) => {
      handlerCalls += 1;
      res.status(200).json({ call: handlerCalls });
    });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      trapped.push(err);
      // Response is already sent (this fires from the finish-time cache write);
      // the error middleware can only observe.
      if (!res.headersSent) {
        res.status(599).json({ trapped: true });
      }
    });

    // First request: handler runs, response sent (200), store.set rejects on
    // finish. We need to await the next event-loop tick for the post-response
    // error middleware invocation to complete.
    const first = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'set-fail-key')
      .send({});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ call: 1 });
    expect(handlerCalls).toBe(1);

    // Yield once so the 'finish' listener (which runs the rejected set + the
    // post-response error middleware) gets a chance to execute before we
    // assert on trapped errors.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The error middleware observed the set rejection.
    expect(trapped).toHaveLength(1);
    expect((trapped[0] as Error).message).toBe('set-failed');
    expect(setCalls).toHaveLength(1);

    // Second request: same key + same body. Because the failed set never
    // persisted anything, the next store.get returns null → cache miss →
    // handler runs again fresh.
    const second = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'set-fail-key')
      .send({});
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ call: 2 });
    expect(second.headers['idempotency-replay']).toBeUndefined();
    expect(handlerCalls).toBe(2);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(setCalls).toHaveLength(2);
    expect(trapped).toHaveLength(2);
  });
});
