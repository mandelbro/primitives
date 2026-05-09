# API Client Retry & Backoff

Thin `fetch` wrapper that adds retries with exponential backoff, honors `Retry-After`, and cancels cleanly on `AbortSignal`. Built with TypeScript, tested with Vitest, no runtime dependencies.

## Specification

See the spec file [api-client-retry-backoff-spec.md](api-client-retry-backoff-spec.md) for the specification.

## Quick start

```bash
pnpm install
pnpm test          # vitest run — 37 cases across 20 atomic spec tests
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
```

## Layout

| Path | What it is |
|---|---|
| `api-client-retry-backoff-spec.md` | The spec — public API, design decisions, atomic test plan |
| `src/fetch-with-retry.ts` | Implementation (~90 lines) |
| `src/types.ts` | `RetryRequest`, `RetryResponse`, `RetryOptions`, `BufferedBody` |
| `tests/fetch-with-retry.test.ts` | 37 cases mapping to the 20 covered spec tests |

Read the spec first. The implementation follows it; the tests pin it.

## Public API at a glance

```typescript
const send = fetchWithRetry({
  fetch: platformFetchAdapter,                           // required
  // All optional — defaults shown
  maxAttempts: 4,
  baseMs: 250,
  maxMs: 30_000,
  retryOn: (status) => status === 429 || status === 503 || status === 504,
  isIdempotent: (req) => ['GET','HEAD','PUT','DELETE'].includes(req.method),
  clock: () => Date.now(),
  sleep: (ms, signal) => /* setTimeout-based with abort honoring */,
});

const res = await send({
  method: 'GET',
  url: 'https://api.example.com/v1/things',
  headers: { authorization: 'Bearer …' },
  body: undefined,           // BufferedBody = Uint8Array | string | undefined
  signal: abortController.signal,
});
// res: { status, headers, body }  — never throws on retriable status
```

Curried shape — one-time policy setup, reusable across many requests. The returned function is a transparent pipe: it doesn't catch errors that aren't part of its retry contract, doesn't mutate the request, doesn't transform the response.

## Design highlights

These are the non-obvious choices worth flagging. Full rationale lives in the spec under **Design Decisions**.

- **Buffered body, not platform `Request`.** SDK-internal types use `Uint8Array | string | undefined` for the body. Platform `Request.body` is a `ReadableStream` you can only consume once — a stream-bodied request that fails on attempt 1 sends an empty body on attempt 2 and gets a 400. The adapter buffers at the SDK boundary; `fetchWithRetry` assumes it can replay.
- **`isIdempotent` gates *both* retry paths.** Status retry (429/5xx) and network-error retry both consult the same predicate. Default denies POST on either path; caller overrides to `() => true` when an `Idempotency-Key` makes POST safe.
- **`Retry-After` consumes an attempt.** Server hint counts against `maxAttempts` the same as a computed backoff. Prevents a hostile or misbehaving server from pinning the client past its configured budget by repeatedly returning 429 with a long delay.
- **`Retry-After` parser is digits-XOR-letters.** Pure digits → delta-seconds. Has letters → `Date.parse` (HTTP-date / RFC 850 / asctime all contain day and month names). Anything else (`'5.5'`, `'-3'`) falls through to computed backoff. The letter guard is load-bearing — V8's `Date.parse('5.5')` returns a finite number for some past date, which would silently produce `0ms` sleep without it.
- **Single `maxMs` clamp, not separate `maxRetryAfterMs`.** One ceiling is easier to reason about than two. A caller who wants longer server-honored delays raises `maxMs`; the trade-off lives in one place. We'll split if real cases warrant it.
- **Clock injection is dependency injection, not test mocking.** `Date.now()` by default; tests pass a controllable `() => number` to make HTTP-date math deterministic. Lets us assert `'retry-after: <future-iso-date>'` produces the exact expected delay without race conditions.
- **`AbortSignal` threaded into *both* fetch and sleep.** The signal travels on `req.signal` straight through to `fetchImpl`, *and* is passed as the second arg to `sleep`. Abort during request: fetch rejects, the wrapper propagates. Abort during backoff: sleep rejects, the wrapper propagates. No path swallows abort.
- **`AbortError` propagates unchanged — same reference.** The `try/catch` around fetch starts with `if (isAbortError(err)) throw err;`. Without that line, the network-error retry branch would happily catch an abort and start a fresh attempt — which is the bug test 18's `.toBe(abortError)` referential-equality assertion guards against.
- **No jitter.** Capped exponential backoff is deterministic and easier to debug. Jitter is overengineering absent a real production use case (observed retry-herd contention). YAGNI.

## Out of scope for v1 (verbal answers ready)

- **Telemetry hook.** Per-attempt span emission for OTel/Datadog. A `onAttempt(meta)` callback fits cleanly between fetch and the retry-decision logic. Out for v1; structured logging at the SDK boundary covers most observability needs.
- **Circuit breaker.** Trip after N consecutive failures, half-open after a cooldown. Worth adding when we see enough cascade-failure signal to justify the policy surface; v1 relies on `maxAttempts` and `Retry-After`.
- **Retry budget.** Cap retries-per-window across all requests to avoid amplifying server stress during a partial outage. Token-bucket-shaped, single-tenant. Sketches well; real value depends on the SDK's caller mix.
- **Per-operation policy table.** Different `maxAttempts` / `retryOn` for `getEmbedding` vs `bulkUpsert`, etc. Today the policy is uniform; teams that need this can compose multiple `fetchWithRetry` instances.
- **`Idempotency-Key` helper.** Auto-generate UUIDs and stamp the header on POST so caller can flip `isIdempotent` to `() => true` safely. Belongs at the SDK boundary, not inside a transport-layer retry primitive.
- **Full jitter.** See last bullet under Design highlights.

## TDD progression

Each cycle was driven by failing tests; refactor only happened when duplication crossed the Rule-of-Three threshold or the spec changed shape.

| Cycle | Spec tests | What was forced into existence |
|---|---|---|
| 1 | #1 | Curried function, `opts.fetch` injection, single-attempt path |
| 2 | #2 | Retry loop, default `retryOn` (429/503/504), default `maxAttempts`=4, default sleep |
| 3 | #3, #4, #5, #20 | Regression armor — multiple-retry sequences, exhaustion fallback, mid-sequence abandonment, non-retriable codes |
| 4 | #11, #13 | Exponential backoff math (`baseMs * 2^(attempt-1)`), `maxMs` clamp |
| 5 | #6, #8, #9, #10, #19 | `Retry-After` delta-seconds parser, edge cases (zero, garbage, clamp, attempt budget) |
| 6 | #7 | HTTP-date format with injected `clock`. **Caught a regression**: parameterized garbage tests (`'5.5'`, `'-3'`) failed because V8's `Date.parse` is permissive — added the alphabetic-character guard |
| 7 | #23 | `req.signal` threaded into `sleep` — one-line wire-through, big behavior delta |
| 8 | #18 | `AbortError` `DOMException` propagation contract — same reference, never re-wrapped, never caught for retry. **Staked out the regression target** that cycle 9 would test against |
| 9 | #21, #22 | Network-error retry gated by `isIdempotent`. **Surfaced a spec gap**: status-side retry wasn't gated on idempotency — POST/503 was being retried. Closed with a focused red+green pair (extra test + one-clause fix) |
| 10 | #14, #16 | Body replay across retries (bytes equality, not reference), request non-mutation between attempts (`structuredClone` snapshot) |
| 11 | (production gap) | `defaultSleep` was ignoring its `signal` parameter — exercised via no-injection path, drove the proper `addEventListener('abort', …)` implementation |

**Skipped with rationale**: #12 (no-jitter — pinned by spec, removed as redundant test surface), #15 (stream-body rejection — enforced at the type level by `BufferedBody`), #17 (signal-to-fetch forwarding — structurally guaranteed by passing `req` through unchanged).
