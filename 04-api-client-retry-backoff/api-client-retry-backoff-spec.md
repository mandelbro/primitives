# API Client Retry & Backoff

## What is it?

A small wrapper around `fetch` that adds retries with backoff. The use-case for this would be in API clients shipped with an SDK that allows callers to make one logical call into the SDK, and deterministically return a response, obfuscating all transport attempts and communication with the API server. It lives at the lowest layer of the SDK stack, below auth, pagination, typed resource clients, etc., it honors server-supplied backoff guidance, and ships with reasonable but configurable defaults for retrying transient errors and gracefully giving up when the server communicates an un-retryable error.

### From the prompt

The signature is `fetchWithRetry(opts?) => (req: Request) => Promise<Response>`. Defaults: max four attempts, base 250ms, cap 30 seconds. Retry on 429 and 5xx. Honor `Retry-After`. Don't retry POST by default — caller can override. Cancel cleanly when an `AbortSignal` fires.

## Public API

```typescript
function fetchWithRetry(opts?: {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  retryOn?: (status: number) => boolean;
  isIdempotent?: (req: Request) => boolean;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): (req: Request) => Promise<Response>;
```

The `opts` object is optional, and if not provided, the defaults are used:

- `maxAttempts`: the maximum number of attempts to make. The default is 4.
- `baseMs`: the base delay in milliseconds. The default is 250.
- `maxMs`: the maximum delay in milliseconds. The default is 30000.

```typescript
// Types

// Request
type Request = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: BodyInit;
  signal: AbortSignal;
};

// Response
type Response = {
  status: number;
  headers: Record<string, string>;
  body: Body;
};

// Configuration Options
type Options = {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  retryOn?: (status: number) => boolean;
  isIdempotent?: (req: Request) => boolean;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
```

## Design Decisions

### Default retry on 429 and retriable 5xx (503, 504)

We're retrying on 429 and retriable 5xx (503, 504) because the server is signaling either "you're over a limit" or "I'm having a bad time," both of which are transient.

### Default idempotency for GET, HEAD, PUT, and DELETE

We're treating GET, HEAD, PUT, and DELETE as idempotent by default because the HTTP spec says they are. Some teams exclude PUT because applications use it for non-idempotent updates; the HTTP spec says it's idempotent. We're following the spec.

### Default denial of POST retry

We're denying POST retry by default because it's not idempotent. If the caller has an `Idempotency-Key`, they can opt in to retry by overriding `isIdempotent`.

### Honor `Retry-After`

We're honoring `Retry-After` when the server sends it. Two formats per RFC 7231 — integer delta-seconds (`Retry-After: 5`) and HTTP-date (`Retry-After: Fri, 31 Dec 2025 23:59:59 GMT`). Most SDKs handle delta-seconds and silently mishandle dates by passing `NaN` to `setTimeout`, which coerces to 0 / treats as immediate retry, which produces a hot retry loop against the exact server that asked for breathing room. Do both. Trim, validate, fall through to the computed backoff on garbage.

### Clamp `Retry-After` to `maxMs`

A server-supplied `Retry-After` is clamped to `maxMs` (default 30s). We use a single ceiling rather than a separate `maxRetryAfterMs` because one knob is easier to reason about, document, and tune than two. A caller who needs to honor longer server-requested delays can raise `maxMs`; the trade-off is explicit and lives in one place. If we later see real cases where callers want a long computed-backoff ceiling but a short server-hint ceiling (or vice versa), we'll split the knob then.

### Network errors are retriable for idempotent methods, non-retriable for non-idempotent methods

We're retrying network errors for idempotent methods because the request is safe to retry. We're not retrying network errors for non-idempotent methods because the request is not safe to retry.

### Aborts pending sleep when the outer `AbortSignal` fires

We're aborting the sleep when the outer `AbortSignal` fires because the request is no longer valid.

### `Retry-After` consumes an attempt

A `Retry-After` delay counts against `maxAttempts` the same as a computed backoff. Honoring the server's hint does not grant a free attempt. This prevents a hostile or misbehaving server from pinning the client past its configured retry budget by repeatedly returning 429 with a long `Retry-After`.

### SDK-internal `Request`/`Response` with buffered body

The `Request` and `Response` types above are SDK-internal, not the platform `fetch` types. Two reasons.

First, retry requires the body to be replayable. The platform `Request.body` is a `ReadableStream` that can only be consumed once, so a stream-bodied request that fails on attempt 1 cannot be retried — the second `fetch` would send an empty body and the server would 400. The SDK adapter buffers any caller-supplied body to `Uint8Array` (or string) before the first attempt and reuses that buffer on every retry. Callers passing an unbuffered stream get a clear error at the SDK boundary, not a silent failure on attempt two.

Second, `headers: Record<string, string>` is sufficient for our SDK's traffic and simpler than `Headers`. Multi-value request headers are out of scope for v1; on the response side, the adapter joins repeated headers with `, ` per RFC 7230 §3.2.2 where applicable (`Set-Cookie` is the documented exception and is not exposed by this layer).

## Error States

1. All retry attempts failed
2. A non-retriable error was thrown
3. The request was aborted

## Test Plan

1. Success path with no retries
2. Retries after 429, 503, 504 once and returns 200
3. Retries after 429, 503, 504 multiple times and returns 200
4. Returns the last response on retry exhaustion
5. Returns the last response on non-retriable error
6. Honors `Retry-After` when the server sends it in integer delta-seconds format
7. Honors `Retry-After` when the server sends it in HTTP-date format
8. Honors `Retry-After: 0` as "retry immediately"
9. Falls back to the computed backoff when `Retry-After` is whitespace-only or unparseable
10. Clamps `Retry-After` to `maxMs`
11. Backoff produces 250ms, 500ms, 1000ms, 2000ms for attempts 1–4 with default `baseMs=250`
12. Backoff is deterministic across runs — no jitter is applied
13. Backoff is clamped to `maxMs` (e.g., `baseMs=10000, maxMs=15000` → 10000, 15000, 15000)
14. Replays the buffered request body across retries — server receives identical body on every attempt
15. Rejects at the SDK boundary when the caller passes an unbuffered stream body
16. Does not mutate the input `Request` between attempts — headers from response N do not leak into request N+1
17. Forwards the outer `AbortSignal` to the in-flight `fetch`, not just to pending sleep
18. Rejects with an `AbortError` (`DOMException`) when aborted, regardless of whether abort fires during fetch or sleep
19. A `Retry-After` delay consumes one attempt against `maxAttempts` — server cannot pin the client past the configured budget
20. Does not retry after non retriable 4xx and 5xx errors
21. Does not retry after network errors for non-idempotent methods (POST by default)
22. Retries after network errors for idempotent methods (GET, HEAD, PUT, DELETE by default)
23. Aborts pending sleep when the outer `AbortSignal` fires

## Out of Scope

1. Full jitter: we're using capped exponential backoff without jitter. Jitter adds non-determinism that complicates debugging and test reproducibility, and is overengineering absent a production use case (e.g., observed retry-herd contention) that justifies the cost. We'll add it when the need is concrete, not speculative.
2. Telemetry hook: we're not adding a telemetry hook for OTel spans.
3. Circuit breaker: we're not adding a circuit breaker.
4. Retry budget: we're not adding a retry budget.
5. Per-operation policy table: we're not adding a per-operation policy table.
6. Idempotency-Key helper: we're not adding an idempotency-key helper.
