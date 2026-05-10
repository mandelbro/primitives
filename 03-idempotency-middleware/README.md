# Express Idempotency Middleware

Express middleware that supports the `Idempotency-Key` header on write requests, scoped per-tenant, that caches successful and client-error responses keyed on a fingerprint of the request and replays them verbatim on retry. Built with TypeScript, tested with Vitest, no runtime dependencies beyond `express` types.

## Specification

See the spec file [express-idempotency-middleware-spec.md](express-idempotency-middleware-spec.md) for the specification.

## Quick start

```bash
pnpm install
pnpm test          # vitest run — 49 cases across 41 atomic spec tests + 3 gap-extension tests
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
```

## Layout

| Path | What it is |
|---|---|
| `express-idempotency-middleware-spec.md` | The spec — public API, design decisions, atomic test plan |
| `src/index.ts` | Implementation (~290 lines) |
| `tests/*.test.ts` | 49 cases across 10 files, one per TDD batch |

Read the spec first. The implementation follows it; the tests pin it.

## Public API at a glance

```typescript
import express from 'express';
import { createIdempotencyMiddleware } from 'express-idempotency-middleware';

const app = express();

// Caller wires raw body bytes via express.json's `verify` callback.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use(createIdempotencyMiddleware({
  store,                                    // required — caller's backing store
  scope: req => String(req.tenantId),       // required — security boundary
  // All optional — defaults shown
  ttlMs: 86_400_000,                        // 24h
  clock: () => Date.now(),
  trackedMethods: new Set(['POST','PUT','PATCH','DELETE']),
}));

app.post('/widgets', handler);
```

On retry with the same `Idempotency-Key`, the middleware replays the cached response verbatim — same status, same headers, same bytes — with `Idempotency-Replay: true` set unconditionally. Different request payload + same key returns a 422 `fingerprint_mismatch` envelope; handler is not invoked, cache is not overwritten.

## Design highlights

These are the non-obvious choices worth flagging. Full rationale lives in the spec under **Design Decisions**.

- **`scope` is required, no default.** Cross-tenant cache collisions are a security incident, not a misconfiguration. We refuse to ship a default that could silently produce them. Single-tenant deployments pass `() => 'global'` explicitly.
- **Raw bytes for the fingerprint, not canonicalized JSON.** Same key plus same exact bytes equals same operation. Canonicalization would be more lenient but commits us to a JSON-only world and adds a parser dependency to a primitive that should not have one.
- **Cache-then-execute control flow.** Cache hit with matching fingerprint replays; cache hit with non-matching fingerprint emits 422 inline; cache miss runs the handler and writes on `res 'finish'` if the status is in the cacheable range. The early `return` on any cache hit is what guarantees "handler is NOT invoked".
- **Status caching boundary: `200 ≤ status < 500`.** 2xx is success, 3xx is a deterministic redirect, 4xx is a deterministic client error — all replay correctly. 5xx is transient and pinning it for 24h would be malpractice. Boundary is exact.
- **"Nothing cached on handler error" is provided by the status boundary, not an independent mechanism.** Express provides no clean public API for a non-error middleware to detect downstream handler errors when the error middleware emits a cacheable status. The status-boundary skip combined with the convention that handler exceptions surface as 5xx is the de-facto mechanism. Caller code that re-maps thrown errors to 4xx accepts the cacheability tradeoff.
- **`Content-Length` recomputed on replay, unconditionally.** Cached headers may legitimately lack one (multi-chunk emission triggers chunked transfer encoding). The cached body's byte length is the only authoritative source on replay.
- **`Idempotency-Replay: true` overrides any cached value.** The cached headers reflect the *original* response (which may have set `false`); the contract says replay must signal itself regardless.
- **Body buffering is the caller's responsibility.** The middleware reads `req.rawBody`. We do not pipe the request stream ourselves because doing so would consume it before downstream body parsers. The standard `express.json({ verify })` recipe makes this a one-line wiring.
- **Store failures propagate to `next(err)`.** Failing open (proceed as if no cache) would silently allow duplicate execution. Failing closed with our own envelope would couple us to an error format. Delegating to the app's error middleware is the right boundary.
- **Validation throws synchronously at construction; per-request defensive checks omitted.** `scope(req)` returning a non-string is a caller bug that surfaces in any test. Construction-time resolution captures all values in closure — the caller's `opts` object is never mutated.

## Out of scope for v1 (verbal answers ready)

- **In-flight concurrency control (CRITICAL for production).** Two requests with the same key arriving close enough that the first hasn't yet written its cached response will both execute the handler. For idempotency to hold under concurrent retries, production needs an atomic compare-and-set "in-flight" marker in the store, claimed before the handler runs and released after it resolves. We omit it because the CAS semantics push real complexity into every backing store. **Do not deploy this primitive in front of non-idempotent side effects without first adding in-flight tracking.** Spec sketches the extension shape.
- **Built-in `Store` implementations.** No in-memory or Redis store ships with the primitive — caller wires their own. A trivial in-memory store may live in `examples/` for demos.
- **Streaming response bodies.** Bodies are buffered in memory before caching. Multi-megabyte streamed responses are not the use case.
- **Compression-aware caching.** If the upstream stack adds `Content-Encoding: gzip` after this middleware captures the body, the cached body and headers may disagree. Order the middleware after compression.
- **Hop-by-hop header scrubbing.** We recompute `Content-Length` on replay; we do NOT strip `Connection`, `Transfer-Encoding`, etc. Typical handlers don't emit these explicitly.
- **Telemetry hooks.** No OTel spans, no metrics callbacks. Add them at the app layer.

## TDD progression

10 batches driven by the spec's 41 numbered tests plus 3 gap-extension tests added in B1. Refactor only happened when duplication crossed Rule-of-Three or when a spec/code drift surfaced.

| Batch | Spec tests | What was forced into existence |
|---|---|---|
| 1 | T1–T5 + 3 gaps | Factory validation: store/scope required; ttlMs/clock/trackedMethods type-checked. Internal validators (`isStoreLike`, `isIterable`, `normalizeTrackedMethods`) |
| 2 | T6–T10 | Tracked-method dispatch; passthrough on missing/whitespace key; case normalization of `trackedMethods` at construction. T11 absorbed into B3 (same machinery as cache-key trim) |
| 3 | T11–T15 | Cache-key composition (`${scope(req)}:${trimmedKey}`); SHA-256 fingerprint of method + originalUrl + raw body; `storedAt` stamped from injected clock; `res.end` wrap + finish-time `store.set` on cacheable status |
| 4 | T16–T19 | All four body-emission paths captured through one interceptor (`res.json`, `res.send`, multi-chunk `res.write` + `res.end`, bare `res.end`). **Refactor**: extracted `shadowResponseBody` + `res.on('finish')` from the prior closure-based pattern; cleaner separation between body shadowing and cache-write triggering |
| 5 | T20–T24 | Cache-hit + matching fingerprint replay branch; `replayCachedResponse` helper with three header overrides (cached verbatim → `Idempotency-Replay: true` → recompute `Content-Length`). **Test-design fixes mid-batch**: T22 redesigned (original premise broken — Express overrode handler's wrong `Content-Length`), T23 hardened with `handlerCalls === 1` to prevent false-positive green |
| 6 | T25–T27 | Fingerprint mismatch envelope path; `sendFingerprintMismatch` helper; cache-hit dispatcher branches replay vs mismatch with single early `return` guarding both invariants ("handler not invoked" + "cache not overwritten") |
| 7 | T28, T29 | **Design pivot**: original 4xx-error-handler tests exposed an Express-architecture limitation — no clean public API for non-error middleware to detect downstream handler errors when the error middleware emits a cacheable status. Tests softened to default 500 handler; spec updated to make the status-boundary + 5xx-convention mechanism explicit |
| 8 | T30, T31 | TTL expiration via injected clock advancing past `storedAt + ttlMs`; per-request `now()` threading to `store.get`. **New fixture**: `makeTtlStore()` honoring the spec's `Store.get` contract |
| 9 | T32–T38 | Status-boundary lock across 200/301/404/422 (cached) and 500/503 (not cached), parameterized via `describe.each`; T38 pins the natural transient-then-success sequence (503 → retry runs fresh → 200 → retry replays). All green-by-default |
| 10 | T39–T41 | Tenant scope isolation (tenant identifier baked into response body so leaks would be observable); `store.get`/`store.set` rejection forwarding via `next(err)`; post-response timing race resolved with `setImmediate` await for the error middleware to observe |

**Out-of-band refactors during the session**: `toBytes` simplified via Buffer/Uint8Array equivalence (Buffer extends Uint8Array); custom `concatBytes` helper deleted in favor of inlined `Buffer.concat` at its single call site.

**Post-session refactor**: `createIdempotencyMiddleware` body extracted into `idempotencyRequestHandler` + `getFromCacheOrExecuteHandler`; resolved options captured once in closure as `ResolvedOptions` (no per-request normalization, no caller-`opts` mutation).
