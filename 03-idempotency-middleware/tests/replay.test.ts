import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import {
  createIdempotencyMiddleware,
  type CachedResponse,
  type Store,
} from '../src/index.js';

interface MemoryStore extends Store {
  readonly getCalls: Array<{ key: string; now: number }>;
  readonly setCalls: Array<{ key: string; value: CachedResponse; ttlMs: number }>;
}

const makeMemoryStore = (): MemoryStore => {
  const map = new Map<string, CachedResponse>();
  const getCalls: MemoryStore['getCalls'] = [];
  const setCalls: MemoryStore['setCalls'] = [];
  return {
    getCalls,
    setCalls,
    async get(key, now) {
      getCalls.push({ key, now });
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
  app.delete('/widgets/:id', handler);
  return app;
};

describe('createIdempotencyMiddleware — replay verbatim', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = makeMemoryStore();
  });

  // T20
  it('same key + same fingerprint replays cached body, status, and headers verbatim; handler NOT called', async () => {
    let handlerCalls = 0;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        handlerCalls += 1;
        res.status(201).set('X-Custom', 'echo').json({ id: 99, ok: true });
      },
    );

    const first = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'replay-key-1')
      .send({ name: 'thing' });

    const second = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'replay-key-1')
      .send({ name: 'thing' });

    expect(handlerCalls).toBe(1);
    expect(second.status).toBe(first.status);
    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);
    // Cached custom header survives replay verbatim.
    expect(second.headers['x-custom']).toBe('echo');
  });

  // T21
  it("replay sets 'Idempotency-Replay: true' (literal string), unconditionally overwriting any cached value", async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        // Handler explicitly sets a contradictory Idempotency-Replay value on the
        // ORIGINAL response. The cached headers contain 'false'; replay must override.
        res.status(200).set('Idempotency-Replay', 'false').json({ ok: true });
      },
    );

    const first = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'replay-flag-key')
      .send({});
    expect(first.headers['idempotency-replay']).toBe('false');

    const second = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'replay-flag-key')
      .send({});
    expect(second.headers['idempotency-replay']).toBe('true');
  });

  // T22
  it("replay recomputes Content-Length from the cached body's byte length, even when cached headers lack one", async () => {
    const chunkA = Buffer.from('AAAAA');
    const chunkB = Buffer.from('BBBBB');
    const expectedLength = chunkA.length + chunkB.length;

    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        // Multi-chunk emission: Express does NOT set Content-Length here; Node
        // typically uses chunked transfer encoding. The cached headers will
        // therefore lack a Content-Length, so the replay MUST compute one from
        // the cached body length.
        res.status(200).type('application/octet-stream');
        res.write(chunkA);
        res.write(chunkB);
        res.end();
      },
    );

    await request(app).post('/x').set('Idempotency-Key', 'cl-key').send({});

    // Precondition: cached headers do not carry an authoritative Content-Length.
    expect(store.setCalls).toHaveLength(1);
    expect(store.setCalls[0]!.value.headers['content-length']).toBeUndefined();
    expect(store.setCalls[0]!.value.body.length).toBe(expectedLength);

    const second = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'cl-key')
      .send({});

    expect(second.headers['content-length']).toBe(String(expectedLength));
    expect(Buffer.from(second.body).equals(Buffer.concat([chunkA, chunkB]))).toBe(true);
  });

  // T23
  it('replay preserves multi-value Set-Cookie headers as distinct lines (handler not re-invoked)', async () => {
    let handlerCalls = 0;
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        handlerCalls += 1;
        res.append('Set-Cookie', 'a=1; Path=/');
        res.append('Set-Cookie', 'b=2; Path=/');
        res.status(200).json({ ok: true });
      },
    );

    const first = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'cookie-key')
      .send({});
    expect(first.headers['set-cookie']).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);

    const second = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'cookie-key')
      .send({});
    // Replay must reproduce both Set-Cookie lines AND not re-run the handler;
    // otherwise this test only proves handler determinism, not replay fidelity.
    expect(handlerCalls).toBe(1);
    expect(second.headers['set-cookie']).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
  });

  // T24
  it("with req.rawBody undefined on both calls, fingerprint matches via method+originalUrl alone; replay works for verb-only ops (DELETE /widgets/:id)", async () => {
    let handlerCalls = 0;
    // No express.json + verify wiring → req.rawBody is undefined throughout.
    const app = express();
    app.use(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
    );
    app.delete('/widgets/:id', (_req, res) => {
      handlerCalls += 1;
      res.status(204).end();
    });

    const first = await request(app)
      .delete('/widgets/123')
      .set('Idempotency-Key', 'delete-key');
    expect(first.status).toBe(204);

    const second = await request(app)
      .delete('/widgets/123')
      .set('Idempotency-Key', 'delete-key');
    expect(second.status).toBe(204);
    // Handler ran exactly once: the second call is a replay.
    expect(handlerCalls).toBe(1);
    expect(second.headers['idempotency-replay']).toBe('true');
  });
});
