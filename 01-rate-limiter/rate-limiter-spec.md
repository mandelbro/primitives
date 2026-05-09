# Token Bucket Rate Limiter — Specification

In-memory token bucket rate limiter with per-key isolation. Buckets refill lazily based on elapsed time; requests debit a configurable cost; denied requests return either a transient retry hint or a permanent rejection.

---

## Public API

```typescript
export type Clock = () => number;

export type ConsumeResult =
  | {
      readonly ok: true;
      readonly remaining: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'rate_limited';
      readonly retryAfterMs: number;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'request_exceeds_capacity';
      readonly message: string;
    };

export interface PeekResult {
  readonly remaining: number;
  readonly capacity: number;
}

export interface RateLimiter {
  /**
   * Attempt to debit `cost` tokens from `key`'s bucket.
   * Lazily creates the bucket on first call, initialized full.
   *
   * @param key   Tenant id, API key, or any opaque bucket identifier.
   * @param cost  Tokens to debit. Must be a positive integer. Defaults to 1.
   * @returns Discriminated union describing success or the denial reason.
   * @throws  If `cost` is not a positive integer or is non-finite.
   */
  consume(key: string, cost?: number): ConsumeResult;

  /**
   * Read `key`'s bucket state without debiting.
   * Triggers the same lazy refill calculation as `consume`. Lazily creates
   * the bucket if absent.
   */
  peek(key: string): PeekResult;
}
```

**Construction (concrete class):**

```typescript
new TokenBucketRateLimiter(
  capacity: number,             // positive integer; max tokens per bucket
  refillRatePerSecond: number,  // positive finite number; tokens/sec
  clock?: Clock,                // defaults to performance.now()
);
```

Positional args are deliberately chosen for v1 — three args, only one optional, no swap-confusable adjacent same-typed primitives. Promote to a named `RateLimiterConfig` object when any of these become true: a fourth field is added; two same-typed numeric fields become adjacent; a factory or builder is introduced; or an external caller needs to type a config-shaped variable.

---

## Design Decisions

### 1. Sync API

The JS event loop is single-threaded; a synchronous `consume` cannot be interleaved mid-call, so no locking or CAS is required. If this ever moves behind Redis, the async boundary lives at that adapter, not here.

### 2. Discriminated union return — no exceptions for control flow

The two denial modes have different operational meaning. `rate_limited` is transient (retry after `retryAfterMs`); `request_exceeds_capacity` is permanent (no amount of waiting will help). Forcing callers to discriminate at the type level prevents "retry forever" loops on requests that can never succeed.

### 3. Clock injection is dependency injection, not a test backdoor

"Current time" is a side-effecting dependency. The default `performance.now()` is monotonic — immune to NTP / DST shifts that can otherwise produce negative `elapsed` and phantom token refunds. Tests pass a controllable function; production omits the option entirely.

### 4. Lazy refill, no scheduled loop

Refill is computed on every `consume` and `peek`:

```
added         = elapsedMs * refillRatePerSecond / 1000
currentTokens = min(capacity, currentTokens + added)
```

No timers, no background work, no wakeups.

### 5. `lastChecked` updates on every refill computation

Regardless of allow/deny outcome. If we updated only on successful debit, a deny-storm (100 rps against an empty bucket) would freeze the refill window precisely when the bucket is most under pressure. This rule is load-bearing — tests pin it.

### 6. Token storage: float internally, integer comparison at debit

`elapsed * refillRate` is fractional. Storing tokens as a float preserves sub-token credit across calls. A debit succeeds when `floor(currentTokens) >= cost`.

### 7. `retryAfterMs` uses `Math.ceil`

Rounding down would invite the caller to retry one millisecond early and be denied again — wasted RTT. Rounding up is safe.

### 8. Cost is an integer the caller passes; no "cost hook"

The original draft hand-waved an "application-domain hook" for cost weighting. v1 keeps the surface minimal: callers compute cost and pass it. If a hook is ever needed it composes outside the limiter.

### 9. Validation throws at the boundary

Invalid config (capacity ≤ 0 or non-integer; refillRate ≤ 0; non-finite values) throws from the constructor. Invalid `cost` (≤ 0, non-integer, non-finite) throws from `consume`. These are programmer errors, not runtime conditions, and should fail loudly and early.

### 10. Eviction is out of scope for v1

The internal `Map<key, BucketRecord>` grows with the unique-key set. For attacker-controlled keys (raw IPs, unauthenticated clients) this is a memory-DoS vector. Mitigations (LRU bound; TTL eviction of full-and-idle buckets — a bucket at capacity with stale `lastChecked` is indistinguishable from a freshly created one) are deferred. Call this out when discussing production readiness.

---

## Canonical Error Messages

### `rate_limited`

```
"Rate limit exceeded. Retry in {n} ms."
```

**Example:** 0 tokens, 1 needed, 4 tokens/s → `"Rate limit exceeded. Retry in 250 ms."`

### `request_exceeds_capacity`

```
"Request cost ({cost}) exceeds bucket capacity ({capacity})."
```

**Example:** `cost=20`, `capacity=10` → `"Request cost (20) exceeds bucket capacity (10)."`

---

## Test Plan (atomic, behavior-focused)

### Construction & validation

1. Constructs successfully with a valid config.
2. Throws when `capacity ≤ 0`.
3. Throws when `capacity` is non-integer.
4. Throws when `refillRatePerSecond ≤ 0`.
5. Throws when any numeric config value is non-finite (`NaN`, `±Infinity`).

### Fresh bucket

6. `peek()` on a never-seen key returns `{ remaining: capacity, capacity }`.
7. First `consume()` on a never-seen key debits from a full bucket.

### Debit semantics

8. `consume(key, 1)` decrements remaining by exactly 1.
9. `consume(key, 3)` decrements remaining by exactly 3 (cost weighting).
10. Successive consumes drain the bucket to exactly 0.
11. `consume` on an empty bucket returns `{ ok: false, reason: 'rate_limited' }`.
12. A `rate_limited` denial does NOT change remaining tokens.

### `retryAfterMs` correctness

13. Empty bucket, `cost=1`, `refillRate=4/s` → `retryAfterMs === 250`.
14. `retryAfterMs` is rounded UP (`Math.ceil`) for non-exact divisions.
15. Advancing the clock by exactly `retryAfterMs` makes the next `consume` (same cost) succeed. The retry hint is honest end-to-end.

### Refill behavior

16. Refills linearly with elapsed time (lazy; no `setInterval`, no timers).
17. Refill is capped at `capacity` even when elapsed would yield more.
18. Sub-token refill credit accumulates across calls (no flooring loss).
19. `lastChecked` updates on every `consume`, including denied ones, so a deny-storm does not freeze the refill window. Verified by asserting the exact `peek().remaining` at each tick — checking only the allow/deny outcome would let bugs slip through where the refill window double-counts but stays just under the cost threshold.

### Permanent rejection

20. `consume(key, cost)` with `cost > capacity` returns `{ ok: false, reason: 'request_exceeds_capacity' }` regardless of current token count. No `retryAfterMs`.
21. `consume` rejects `cost = 0`, negative cost, non-integer cost, and non-finite cost by throwing (validation, not a denial result).

### Per-key isolation

22. Draining key A's bucket leaves key B's bucket untouched.
23. Refill on key A does not depend on activity on key B.

### Determinism via injected clock

24. With an injected clock, advancing time and calling `consume` yields deterministic, framework-independent results — no fake timers.

---

## Out of Scope for v1

- **Bucket eviction:** LRU bound on the internal map, or TTL eviction of full-and-idle buckets.
- **Distributed limiter:** Redis with a Lua script for atomic read-refill-debit-write, or a sliding-window counter via `INCRBY` + `EXPIRE`.
- **Token bucket vs alternatives:** token bucket allows controlled bursts (good for API quotas); leaky bucket smooths to a constant rate (good for queue draining); sliding window gives exact request counts over a period (good for "100 req/min" SLAs but more memory).
- **Observability:** per-key allow/deny counters, retry-after histograms.
- **Async cost computation:** if a future caller needs it, serialize per-key with a promise chain to preserve read-modify-write atomicity.
