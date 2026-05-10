import { describe, it, expect, beforeEach } from 'vitest';
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

const headerLookup = (
  headers: Record<string, string | string[]>,
  name: string,
): string | string[] | undefined => {
  return headers[name] ?? headers[name.toLowerCase()];
};

describe('createIdempotencyMiddleware — response capture', () => {
  let store: SpyStore;

  beforeEach(() => {
    store = makeSpyStore();
  });

  // T16
  it('res.json(obj) cached as JSON-serialized bytes with Content-Type: application/json', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        res.status(200).json({ hello: 'world', nested: { n: 1 } });
      },
    );

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'json-key')
      .send({});

    expect(res.status).toBe(200);
    expect(store.setCalls).toHaveLength(1);
    const entry = store.setCalls[0]!.value;

    // Cached body bytes equal the on-wire bytes (which is what res.json produced).
    expect(Buffer.from(entry.body).toString('utf8')).toBe(res.text);

    // Cached Content-Type starts with application/json.
    const ct = String(headerLookup(entry.headers, 'Content-Type') ?? '');
    expect(ct).toMatch(/^application\/json/);
  });

  // T17
  it("res.send('text') cached as UTF-8 bytes", async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        res.status(200).type('text/plain').send('hello world');
      },
    );

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'send-text-key')
      .send({});

    expect(res.status).toBe(200);
    expect(store.setCalls).toHaveLength(1);
    const entry = store.setCalls[0]!.value;

    // UTF-8 bytes for 'hello world'.
    expect(Buffer.from(entry.body).equals(Buffer.from('hello world', 'utf8'))).toBe(true);
  });

  // T18
  it('res.write(chunk1) + res.write(chunk2) + res.end() cached as concatenation of chunk bytes', async () => {
    const chunk1 = Buffer.from('AAAA');
    const chunk2 = Buffer.from('BBBB');

    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        res.status(200).type('text/plain');
        res.write(chunk1);
        res.write(chunk2);
        res.end();
      },
    );

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'multi-chunk-key')
      .send({});

    expect(res.status).toBe(200);
    expect(res.text).toBe('AAAABBBB');
    expect(store.setCalls).toHaveLength(1);
    const entry = store.setCalls[0]!.value;
    expect(Buffer.from(entry.body).equals(Buffer.concat([chunk1, chunk2]))).toBe(true);
  });

  // T19
  it('res.end() with no body cached as zero-length Uint8Array', async () => {
    const app = buildApp(
      createIdempotencyMiddleware({ store, scope: () => 'g' }),
      (_req, res) => {
        res.status(204).end();
      },
    );

    const res = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'empty-body-key')
      .send({});

    expect(res.status).toBe(204);
    expect(store.setCalls).toHaveLength(1);
    const entry = store.setCalls[0]!.value;
    expect(entry.body).toBeInstanceOf(Uint8Array);
    expect(entry.body.length).toBe(0);
  });
});
