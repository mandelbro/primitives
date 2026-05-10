# Express Idempotency Middleware Specification

## What is it?

Express middleware that supports the `Idempotency-Key` header on write requests, scoped per-tenant by default, that caches successful and client-error responses keyed on a fingerprint of the request and replays them verbatim on retry — including the original status code and headers.

The use-case is the SDK / API-server layer of a system that takes write requests it must execute exactly once even when clients (mobile, batch, retried-by-an-upstream-LB) deliver the same request more than once. The middleware sits in front of the route handler, captures the response, caches it for a fixed TTL, and on retry replays the exact response without invoking the handler.

This primitive intentionally defers in-flight concurrency control (the second of two near-simultaneous retries with the same key) — see *Out of Scope*.

## Public API

```typescript
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Module augmentation: callers wire `req.rawBody` via `express.json({ verify })`
// or equivalent. The middleware reads it without `as any` casts.
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
  /**
   * Returns the cached response for `key`, or null if absent or expired.
   *
   * MUST return null when `storedAt + ttlMs < now`. The store records the
   * `ttlMs` passed to `set` and uses it for this check; `now` is authoritative.
   * Native store eviction (e.g., Redis `EX`) is permitted as a backstop but
   * MUST NOT be the sole expiry mechanism — the `now` argument owns the cutoff.
   */
  get(key: string, now: number): Promise<CachedResponse | null>;

  /**
   * Persists `value` under `key` with `ttlMs` lifetime.
   * Overwrites any existing entry for the same key.
   */
  set(key: string, value: CachedResponse, ttlMs: number): Promise<void>;
}

export interface IdempotencyOptions {
  /** Required. Backing store for cached responses. */
  store: Store;

  /**
   * Required. Returns the scope segment of the cache key for `req`.
   * Callers explicitly pick the security boundary: typically tenant ID,
   * optionally composed with API key. Single-tenant deployments pass
   * `() => 'global'`. There is no default — see "Scope is required".
   */
  scope: ScopeFn;

  /** Optional. Cache TTL in milliseconds. Default 86_400_000 (24h). */
  ttlMs?: number;

  /** Optional. Time source. Default `Date.now`. */
  clock?: Clock;

  /**
   * Optional. HTTP methods that participate in idempotency tracking.
   * All other methods pass through untouched. Compared case-insensitively
   * against `req.method` (which Express normalizes to uppercase).
   * Default `new Set(['POST', 'PUT', 'PATCH', 'DELETE'])`.
   */
  trackedMethods?: ReadonlySet<string>;
}

export function createIdempotencyMiddleware(
  opts: IdempotencyOptions,
): RequestHandler;
```

**Caller contract — request body bytes.** The middleware reads the raw request body from `req.rawBody`. The `Express.Request` type is augmented above; callers wire the value with the standard `verify` recipe:

```typescript
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
```

If `req.rawBody` is undefined, the fingerprint is computed over `${method}\n${originalUrl}\n` only — equivalent to a zero-byte body. This is sufficient for verb-only retries (e.g., `DELETE /widgets/123`), but it also means a request that supplied a body on the first call and `undefined` on the retry produces a fingerprint mismatch (different byte lengths feed the SHA-256). See Test Plan.

## Design Decisions

### Cache-then-execute control flow

As a request arrives, we first check the store for a cached response, keyed on the idempotency key. If a cached response is found, we then compare the request fingerprint with the cached values. If the fingerprint matches, we replay the cached response. If the fingerprint does not match, we return a 422 error. If no cached response is found, we proceed to the handler. After the handler resolves with a cacheable status, we write the response to the store.

### Cache key composition

The cache key is `${scope(req)}:${idempotencyKey}`. The scope return value is the prefix; the trimmed `Idempotency-Key` header is the suffix. The `:` separator is part of the contract — stores that introspect keys (e.g., for namespacing) can rely on it.

### Scope is required (no default)

`scope` is a required option, not defaulted. Cross-tenant cache collisions are a security incident, and we refuse to ship a default that could silently produce them. Callers explicitly choose the security boundary:

- Multi-tenant: `scope: req => req.tenantId` (and accept the consequences if `tenantId` is missing — that's a wiring bug, not a middleware bug).
- Composite: `scope: req => `${req.tenantId}:${req.apiKeyId}``.
- Single-tenant: `scope: () => 'global'`.

The middleware does not validate that `scope(req)` returns a non-empty string at runtime — that's a caller bug, and one that surfaces fast in any test.

### Fingerprint generation

The fingerprint is SHA-256 of `${method}\n${originalUrl}\n` followed by the raw body bytes (zero bytes if `rawBody` is undefined). Hex-encoded, length 64. `originalUrl` includes the query string and any mount-point prefix; this is intentional — `?force=1` and `?force=2` are different operations and must not collide.

Same key plus same exact bytes equals same operation.

### Raw bytes vs canonicalized JSON

We choose raw bytes due to its simplicity and the fact that it is the same for the same request across different processes. Canonicalized JSON would be more lenient (whitespace and key-order tolerance) but commits us to a JSON-only world and adds a parser dependency to a primitive that should not have one.

### Multi-tenant scope isolation

The scope function is the boundary that prevents cross-tenant collisions. The same idempotency key sent by two different tenants must produce different cache keys. If they don't — because the caller's `scope` function is buggy or returns `'global'` for everyone — one tenant can replay another tenant's response, which is not a bug, it's a security incident. We make `scope` required (above) precisely because we won't take responsibility for that boundary by default.

### TTL window

The TTL window is 24 hours in order to support the immediate HTTP retry window, the human-in-the-loop retry window, the offline-mobile-queue retry window, and the nightly-batch retry window.

### Handler throw

If the handler throws (or calls `next(err)`), we propagate the error to the Express error handler. A retry with the same key plus same fingerprint runs the handler fresh.

The middleware does NOT detect "the handler errored" as an independent signal. Express provides no clean public API for a non-error-handling middleware to observe error propagation through the chain (the `next` callback we receive from Express is the same one downstream layers use, but Express does not give us a hook to intercept calls to it from those downstream layers). Instead, the failure not being cached is a consequence of the cacheable-status boundary (see *What gets cached*) combined with the convention that handler exceptions surface as 5xx — Express's default error handler emits 500, which is non-cacheable. If a caller installs a custom error middleware that re-maps thrown errors to a 2xx/3xx/4xx status, that re-mapped response IS cacheable by this middleware; the caller has, by their re-mapping, declared the response a deterministic outcome of the request rather than a transient failure.

### What gets cached: 200 ≤ status < 500 (2xx, 3xx, 4xx)

A 2xx response is a successful operation — replay is the whole point. A 3xx is a deterministic redirect — same input, same redirect target, replay is correct. A 4xx is a deterministic client error (validation failed, missing auth, not found) — replaying it tells the client the same thing they were told the first time. A 5xx is a transient server error and should be re-attempted by the client; caching it would pin the failure for 24 hours. The boundary is exact: status `>= 200 && status < 500` caches; status `< 200` (informational) and `>= 500` do not.

### Response capture mechanism

The middleware captures the handler's response by wrapping `res.write` and `res.end` before invoking the handler:

- `res.write(chunk, ...)`: chunks are pushed into an in-memory `Uint8Array[]` accumulator, then forwarded to the original `res.write`.
- `res.end(chunk?, ...)`: the final chunk (if any) is appended, then a snapshot is taken of `res.statusCode` and `res.getHeaders()`, then the original `res.end` is invoked. After the original returns, the accumulator is flattened to a single `Uint8Array` and — if the status falls in the cacheable range — written to the store under the resolved cache key.

`res.json(...)` and `res.send(...)` ultimately call `res.end` internally, so wrapping the two low-level methods covers all paths. A handler that calls `res.end()` with no body produces a zero-length `Uint8Array` cache entry.

### Header replay rules

On replay:
1. Cached headers are written to the response verbatim, preserving multi-value entries (e.g., `Set-Cookie`) as separate header lines.
2. `Content-Length` is recomputed from the cached body's byte length, overwriting the cached value. This guards against the case where the original handler emitted `Transfer-Encoding: chunked` with no `Content-Length`, or any mismatch between cached headers and cached body length.
3. `Idempotency-Replay: true` is set last (literal string `"true"`), unconditionally overwriting any prior value.

The middleware does NOT scrub other hop-by-hop headers (`Connection`, `Transfer-Encoding`, `Upgrade`, etc.) — see *Out of Scope*.

### Header name and value normalization: `Idempotency-Key`

We pin to `Idempotency-Key` per the IETF HTTP idempotency-key draft. Express normalizes header names to lowercase, so reads use `req.headers['idempotency-key']`. Values are trimmed of leading/trailing whitespace before use; empty strings and whitespace-only values are equivalent to "no header" (passthrough).

### Method matching is case-insensitive

`trackedMethods` is uppercased once at construction time and compared against `req.method` (which Express normalizes to uppercase). A caller passing `new Set(['post'])` gets POST tracking — equivalent to `new Set(['POST'])`. Non-string entries throw at construction.

### Validation: throws at construction

Invalid options throw synchronously from `createIdempotencyMiddleware`:

- `store` missing, or not an object exposing `get` and `set` functions.
- `scope` missing, or not a function.
- `ttlMs` provided but non-positive or non-finite.
- `clock` provided but not a function.
- `trackedMethods` provided but not an iterable of strings.

Per-request defensive checks (e.g., `scope(req)` returning a non-string, `clock()` returning `NaN`) are NOT performed — they're caller bugs that surface immediately in any test, and the cost of guarding against them on every request isn't justified for a primitive.

### Store failures propagate to `next(err)`

If `store.get` or `store.set` rejects, the middleware calls `next(err)`. Failing open (proceed as if no cache) would silently allow duplicate execution. Failing closed with our own error envelope would couple us to an error format. Delegating to the app's error middleware is the right boundary.

### Clock injection is dependency injection, not a test backdoor

`Date.now()` works in production and is the default. Tests pass a controlled function. The middleware passes the configured clock's `now()` value to `store.get` on every request — combined with the `Store.get` contract (which MUST honor `now` as the authoritative cutoff), this makes the middleware the single source of truth for "what time is it" across the stack.

### Body buffering is the caller's responsibility

The middleware reads `req.rawBody`. We do not pipe the request stream ourselves because doing so would consume the stream before downstream body parsers (`express.json`, `express.urlencoded`) get a chance, and re-emitting the buffer as a stream so they still work is over-engineering for a primitive. The standard `express.json({ verify })` recipe makes this a one-line wiring.

## Error States

### Canonical error envelope

The single middleware-emitted error uses this JSON shape:

```json
{
  "error": "fingerprint_mismatch",
  "message": "<human-readable description>"
}
```

The response uses `Content-Type: application/json` and an explicit status code. Body is sent with `JSON.stringify` of the envelope.

### `fingerprint_mismatch` — 422

Returned when the cache holds an entry for the resolved key but the incoming request's fingerprint differs from the cached one. The handler is NOT called and the cache is NOT overwritten. Message: `"Idempotency key reused with a different request payload."`

### Store failures

Any rejection from `store.get` or `store.set` is forwarded via `next(err)` to the Express error handler. The middleware does not transform or re-throw.

### Handler errors

Errors thrown synchronously by the handler, or surfaced via `next(err)`, are forwarded unchanged to the Express error handler. The middleware itself does not transform or intercept the error. Whether the resulting response is cached follows the cacheable-status rule (see *What gets cached*) — under the conventional 5xx-on-error pattern, the response is not cached.

### Tracked verb without `Idempotency-Key`

Passthrough. The handler runs normally; nothing is cached. Empty-string and whitespace-only header values are equivalent to "absent."

### Untracked verb (default: GET, HEAD, OPTIONS, etc.)

Passthrough regardless of the `Idempotency-Key` header value.

## Test Plan (atomic, behavior-focused)

### Construction & validation

1. Constructs successfully with required options only (`store`, `scope`); defaults applied to the rest.
2. Constructs successfully with all options provided.
3. Throws when `opts.store` is missing.
4. Throws when `opts.scope` is missing.
5. Throws when `ttlMs` is non-positive or non-finite.

### Passthrough (no tracking)

6. Tracked verb (POST) with no `Idempotency-Key` header passes through — handler runs, store is never read or written.
7. Tracked verb with whitespace-only `Idempotency-Key` passes through (treated as absent).
8. Untracked verb (GET) with an `Idempotency-Key` header passes through — only mutating verbs are tracked.
9. Untracked verb (HEAD) with an `Idempotency-Key` header passes through.
10. Custom `trackedMethods: new Set(['post'])` (lowercase) tracks POST — case is normalized at construction.
11. `Idempotency-Key` header value with leading/trailing whitespace is trimmed before forming the cache key.

### First write & cache

12. First write with a key executes the handler, returns the result, and populates the cache with the exact status code, headers, and body bytes.
13. The cache entry's fingerprint is the SHA-256 of `${method}\n${originalUrl}\n` + raw body bytes (hex, length 64).
14. The cache entry's `storedAt` equals the injected clock's value at the moment of write.
15. The cache key is `${scope(req)}:${idempotencyKey}` — scope return value is the prefix, trimmed header value is the suffix.

### Response capture

16. Handler uses `res.json(obj)` — body cached as the JSON-serialized bytes; `Content-Type: application/json` cached.
17. Handler uses `res.send('text')` with a string — body cached as UTF-8 bytes.
18. Handler uses `res.write(chunk1)` then `res.write(chunk2)` then `res.end()` — body cached as the concatenation of chunk bytes.
19. Handler calls `res.end()` with no body — empty body cached as a zero-length `Uint8Array`.

### Replay

20. Second write, same key plus same fingerprint: replays the cached body, status code, and headers verbatim. Handler is NOT called.
21. Replay sets `Idempotency-Replay: true` (literal string), unconditionally overwriting any value the handler may have set in the cached headers.
22. Replay sets `Content-Length` to the cached body's byte length, overwriting any cached `Content-Length` value.
23. Replay preserves multi-value `Set-Cookie` headers — multiple cookies survive replay as distinct header lines.
24. With `req.rawBody` undefined on both calls, the fingerprint is computed over `method + originalUrl` only and matches; replay still works for verb-only operations like `DELETE /widgets/123`.

### Fingerprint mismatch

25. Second write, same key plus DIFFERENT body bytes: returns 422 with `{ error: 'fingerprint_mismatch', message: ... }` and `Content-Type: application/json`. Handler is NOT called. Cache is NOT overwritten.
26. Second write, same key, same method and path, DIFFERENT query string: returns 422 (query string is part of `originalUrl`, so fingerprints differ).
27. Second write, same key, asymmetric `rawBody` (defined on first call, undefined on second): returns 422 (body bytes differ — present vs zero-length).

### Handler errors

28. Handler throws synchronously and Express's default error handler emits the resulting 500: the 500 is not cached (per the cacheable-status boundary). A retry with the same key plus same fingerprint runs the handler fresh.
29. Handler calls `next(err)` and Express's default error handler emits the resulting 500: the 500 is not cached. A retry runs the handler fresh.

### TTL & clock

30. After TTL expiration (verified via injected clock advancing past `storedAt + ttlMs`), the same key is treated as fresh: handler runs again, cache is overwritten with the new response.
31. The middleware passes the injected clock's `now()` value to `store.get` on every lookup — verified by a spy store asserting the `now` argument equals `clock()` at call time.

### Status code caching boundary

32. A 200 response is cached; a retry replays it.
33. A 301 response is cached; a retry replays it (deterministic redirects are cacheable).
34. A 404 response is cached; a retry replays it.
35. A 422 response is cached; a retry replays it (validation errors are deterministic).
36. A 500 response is NOT cached; a retry runs the handler fresh.
37. A 503 response is NOT cached; a retry runs the handler fresh.
38. Composite: handler returns 503 (not cached) → retry, handler returns 200 (cached) → retry, replays the 200 verbatim. Pins the natural transient-failure-then-success sequence.

### Scope isolation

39. The same idempotency key sent in requests where `scope` returns `'tenant-a'` and `'tenant-b'` respectively does not collide: each scope gets its own handler invocation and its own cached response. Replaying tenant A's key returns A's response, not B's.

### Store failure propagation

40. `store.get` rejection is forwarded via `next(err)`; handler is NOT called.
41. `store.set` rejection (after a successful handler) is forwarded via `next(err)`. The next retry sees a cache miss (no partial cached side effects).

## Out of Scope

1. **Canonicalized JSON fingerprint generation and comparison.** Raw bytes only.
2. **In-flight concurrency control (CRITICAL for production deployments).** Two requests with the same idempotency key arriving close enough that the first has not yet written its cached response will BOTH execute the handler under this primitive. For idempotency to hold under concurrent retries — the exact failure mode the feature is meant to defend against — production needs an atomic compare-and-set "in-flight" marker in the store, claimed before the handler runs, released after the handler resolves, and self-evicting after a short TTL to handle process crashes. The second concurrent request observes the marker and either (a) coalesces — waits for the first to finish, then replays the cached response — or (b) fails fast with 409 and lets the client retry. We omit both modes here because the CAS semantics push real complexity into the `Store` contract: every backing store (Redis `SET NX EX`, Postgres `INSERT ... ON CONFLICT DO NOTHING`, DynamoDB conditional writes, in-memory map with a mutex) needs its own correctness proof. **Do not deploy this primitive in front of non-idempotent side effects (payments, account creation, outbound API calls, message publishing) without first adding in-flight tracking.** A reasonable extension shape: add `setInflight(key, now, ttlMs): Promise<boolean>` and `clearInflight(key): Promise<void>` to the `Store` interface, plus an `inflightTtlMs` option (60s default) on `IdempotencyOptions`, plus a 409 `in_flight` variant on the error envelope.
3. **Built-in `Store` implementations.** No in-memory or Redis store ships with the primitive — the caller wires their own. A trivial in-memory store may live in `examples/` for demos and tests.
4. **Streaming response bodies.** The middleware buffers the response body in memory before caching. Multi-megabyte streamed responses are not the use case.
5. **Per-route opt-in/opt-out.** Mount the middleware on the routes that need it; mount a different stack on the routes that don't.
6. **Compression-aware caching.** If the upstream stack adds `Content-Encoding: gzip` after this middleware captures the body, the cached body and the cached header may disagree. Order the middleware after compression (or store both forms) — out of scope here.
7. **Hop-by-hop header scrubbing.** The middleware recomputes `Content-Length` on replay (for body-length safety) but does NOT strip other hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailers`, `Transfer-Encoding`, `Upgrade` — RFC 7230 §6.1). Typical Express handlers don't emit these explicitly; if yours does, either filter them at the handler layer or accept that they're cached and replayed.
8. **Per-request defensive validation.** `scope` returning a non-string or empty string, `clock()` returning `NaN`, etc. are caller bugs that surface in tests; the middleware does not guard against them on every request.
9. **Telemetry hooks.** No OTel spans, no metrics callbacks. Add them at the app layer.
