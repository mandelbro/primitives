import type { Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';

declare module 'http' {
  interface IncomingMessage {
    rawBody?: Buffer | Uint8Array;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer | Uint8Array;
  }
}

export type Clock = () => number;

export type ScopeFn = (req: Request) => string;

export interface CachedResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: Uint8Array;
  readonly fingerprint: string;
  readonly storedAt: number;
}

export interface Store {
  get(key: string, now: number): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse, ttlMs: number): Promise<void>;
}

export interface IdempotencyOptions {
  store: Store;
  scope: ScopeFn;
  ttlMs?: number;
  clock?: Clock;
  trackedMethods?: ReadonlySet<string>;
}

const DEFAULT_TTL_MS = 86_400_000;
const DEFAULT_TRACKED_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export function createIdempotencyMiddleware(
  opts: IdempotencyOptions,
): RequestHandler {
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('IdempotencyOptions must be an object');
  }

  if (!isStoreLike(opts.store)) {
    throw new TypeError(
      'IdempotencyOptions.store is required and must expose get and set functions',
    );
  }

  if (typeof opts.scope !== 'function') {
    throw new TypeError('IdempotencyOptions.scope is required and must be a function');
  }

  if (opts.ttlMs !== undefined) {
    if (typeof opts.ttlMs !== 'number' || !Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new RangeError('IdempotencyOptions.ttlMs must be a positive finite number');
    }
  }

  if (opts.clock !== undefined && typeof opts.clock !== 'function') {
    throw new TypeError('IdempotencyOptions.clock must be a function');
  }

  const trackedMethods =
    opts.trackedMethods === undefined
      ? DEFAULT_TRACKED_METHODS
      : normalizeTrackedMethods(opts.trackedMethods);

  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const clock: Clock = opts.clock ?? Date.now;
  const store = opts.store;
  const scope = opts.scope;

  return (req, res, next) => {
    if (!trackedMethods.has(req.method)) {
      next();
      return;
    }
    const key = extractIdempotencyKey(req);
    if (key === null) {
      next();
      return;
    }
    const cacheKey = `${scope(req)}:${key}`;
    const fingerprint = computeFingerprint(req);

    store.get(cacheKey, clock()).then(
      (cached) => {
        if (cached !== null) {
          if (cached.fingerprint === fingerprint) {
            replayCachedResponse(res, cached);
          } else {
            sendFingerprintMismatch(res);
          }
          return;
        }
        // Cache miss: shadow the body, register a finish-time cache write,
        // run the handler.
        const body = shadowResponseBody(res);
        res.on('finish', () => {
          const status = res.statusCode;
          if (status < 200 || status >= 500) return;
          const value: CachedResponse = {
            status,
            headers: { ...res.getHeaders() } as Record<string, string | string[]>,
            body: body.snapshot(),
            fingerprint,
            storedAt: clock(),
          };
          store.set(cacheKey, value, ttlMs).catch((err: unknown) => next(err));
        });
        next();
      },
      (err: unknown) => next(err),
    );
  };
}

/**
 * Emits a cached response on the wire. Cached headers are applied verbatim
 * (multi-value arrays like Set-Cookie survive as distinct lines), then two
 * authoritative overrides: Idempotency-Replay is forced to "true", and
 * Content-Length is recomputed from the cached body's byte length so chunk-
 * encoded originals replay with a correct, single content length.
 */
/**
 * Emits the canonical fingerprint_mismatch envelope. Called when the cache
 * holds an entry for the resolved key but the incoming request's fingerprint
 * differs — a strong signal that the same Idempotency-Key is being reused
 * with a different request payload. The handler is NOT invoked and the cache
 * is NOT overwritten.
 */
function sendFingerprintMismatch(res: Response): void {
  res.status(422).type('application/json').send(
    JSON.stringify({
      error: 'fingerprint_mismatch',
      message: 'Idempotency key reused with a different request payload.',
    }),
  );
}

function replayCachedResponse(res: Response, cached: CachedResponse): void {
  for (const [name, value] of Object.entries(cached.headers)) {
    res.setHeader(name, value);
  }
  res.setHeader('Idempotency-Replay', 'true');
  res.setHeader('Content-Length', String(cached.body.length));
  res.status(cached.status);
  if (cached.body.length === 0) {
    res.end();
  } else {
    res.end(Buffer.from(cached.body));
  }
}

function computeFingerprint(req: Request): string {
  const h = createHash('sha256');
  h.update(req.method);
  h.update('\n');
  h.update(req.originalUrl);
  h.update('\n');
  if (req.rawBody !== undefined) {
    h.update(req.rawBody);
  }
  return h.digest('hex');
}

/**
 * Shadows the bytes of a response by patching res.write and res.end so each
 * chunk is recorded into a private accumulator before being forwarded. Returns
 * a view with `snapshot()`, which the caller invokes after the response ends
 * (typically inside a `res.on('finish', ...)` listener) to obtain the full body
 * as a single Uint8Array. This function does NOT decide what to do when the
 * response completes — that's the caller's job.
 */
function shadowResponseBody(res: Response): { snapshot: () => Uint8Array } {
  const chunks: Uint8Array[] = [];

  const originalWrite = res.write.bind(res);
  res.write = function patchedWrite(this: Response, ...args: unknown[]): boolean {
    const [chunk, maybeEncoding] = args;
    const bytes = toBytes(
      chunk,
      typeof maybeEncoding === 'string' ? (maybeEncoding as BufferEncoding) : undefined,
    );
    if (bytes !== null) chunks.push(bytes);
    return (originalWrite as (...a: unknown[]) => boolean)(...args);
  } as typeof res.write;

  const originalEnd = res.end.bind(res);
  res.end = function patchedEnd(this: Response, ...args: unknown[]): Response {
    const chunk = args.length > 0 && typeof args[0] !== 'function' ? args[0] : undefined;
    const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : undefined;
    const bytes = toBytes(chunk, encoding);
    if (bytes !== null) chunks.push(bytes);
    return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
  } as typeof res.end;

  return {
    snapshot: () => Buffer.concat(chunks),
  };
}

/** Coerce a write/end chunk to its raw bytes, or null if it isn't byte-bearing. */
function toBytes(chunk: unknown, encoding?: BufferEncoding): Uint8Array | null {
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  if (chunk instanceof Uint8Array) return chunk; // also catches Buffer (subclass)
  return null;
}

function extractIdempotencyKey(req: Request): string | null {
  const raw = req.headers['idempotency-key'];
  // normalize the header value to a string
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  // trim the value
  const trimmed = value.trim();
  // if the value is empty, return null
  if (trimmed.length === 0) return null;
  // return the trimmed value
  return trimmed;
}



function isStoreLike(value: unknown): value is Store {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { get?: unknown; set?: unknown };
  return typeof candidate.get === 'function' && typeof candidate.set === 'function';
}

function isIterable(value: unknown): value is Iterable<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'string')) {
    return false;
  }
  return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function normalizeTrackedMethods(value: unknown): ReadonlySet<string> {
  if (!isIterable(value)) {
    throw new TypeError('IdempotencyOptions.trackedMethods must be an iterable of strings');
  }
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new TypeError(
        'IdempotencyOptions.trackedMethods must contain only strings',
      );
    }
    out.add(item.toUpperCase());
  }
  return out;
}
