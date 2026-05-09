# Token Bucket Rate Limiter

In-memory token bucket rate limiter primitive. Built with TypeScript, tested with Vitest, no runtime dependencies.

## Specification

See the spec file [rate-limiter-spec.md](rate-limiter-spec.md) for the specification.

## Quick start

```bash
pnpm install
pnpm test          # vitest run — 44 cases across 24 atomic spec tests
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
```

## Layout

| Path | What it is |
|---|---|
| `rate-limiter-spec.md` | The spec — public API, design decisions, atomic test plan |
| `src/rate-limiter.ts` | Implementation (~125 lines) |
| `tests/rate-limiter.test.ts` | 44 cases mapping to the 24 numbered spec tests |

Read the spec first. The implementation follows it; the tests pin it.

## Public API at a glance

```typescript
const limiter = new TokenBucketRateLimiter(
  10,  // capacity — positive integer
  4,   // refillRatePerSecond — positive finite
  // optional Clock = () => performance.now()
);

limiter.consume('tenant-a', 1);
// { ok: true,  remaining: 9 }
// { ok: false, reason: 'rate_limited',            retryAfterMs, message }
// { ok: false, reason: 'request_exceeds_capacity',                message }

limiter.peek('tenant-a');
// { remaining: 9, capacity: 10 }
```

Three-arg positional constructor — under the threshold where a named config object pays for itself.

## Design highlights

These are the non-obvious choices worth flagging. Full rationale lives in the spec under **Design Decisions**.

- **Discriminated union return, not exceptions.** Rate-limited (transient) and request-exceeds-capacity (permanent) are different operationally. Forcing the caller to discriminate at the type level prevents "retry forever" loops on requests that can never succeed.
- **Clock injection is dependency injection, not test mocking.** `performance.now()` by default; tests pass a controllable `() => number`. `Date.now()` is non-monotonic — NTP shifts can produce negative `elapsed` and phantom token refunds.
- **Lazy refill, no timers.** `(now − lastChecked) × rate / 1000`, capped at capacity, computed inside `consume` and `peek`. No `setInterval`, no background work.
- **Float token storage, integer comparison at debit.** Sub-token refill credit accumulates across calls; a debit succeeds when `Math.floor(tokens) >= cost`. Without this, fine-grained refill (e.g., 0.4 tokens per 100ms tick) silently disappears.
- **`lastChecked` updates on every refill, including denials.** If updated only on successful debit, a deny-storm would freeze the refill window precisely when the bucket is most under pressure. The "load-bearing" rule from spec decision #5.
- **Permanent-rejection check before bucket creation.** `consume(maliciousKey, 999999)` returns `request_exceeds_capacity` without lazy-creating a bucket — small memory-DoS hardening.
- **Cost validation throws.** Invalid `cost` (≤ 0, non-integer, non-finite) is a programmer error, not a runtime denial. Same for invalid constructor args.

## Out of scope for v1 (verbal answers ready)

- **Bucket eviction.** The internal `Map<string, BucketRecord>` grows with the unique-key set. Mitigations: LRU bound, or TTL eviction of full-and-idle buckets (a bucket at capacity with stale `lastChecked` is indistinguishable from a freshly created one).
- **Distributed limiter.** Redis + Lua script for atomic refill-and-debit; or a sliding-window counter via `INCRBY` + `EXPIRE`.
- **Algorithm trade-offs.** Token bucket allows controlled bursts (good for API quotas); leaky bucket smooths to a constant rate (good for queue draining); sliding window gives exact request counts over a period (good for "100 req/min" SLAs but more memory).
- **Observability.** Per-key allow/deny counters, retry-after histograms.
- **Async cost computation.** If a future caller needs it, serialize per-key with a promise chain to preserve read-modify-write atomicity.

## TDD progression

Each cycle was driven by failing tests; refactor only happened when duplication crossed the Rule-of-Three threshold.

| Cycle | Spec tests | What was forced into existence |
|---|---|---|
| 1 | #6 | Class, constructor, `peek`, fresh-bucket-is-full invariant |
| 2 | #1–5 | Constructor validation guards |
| 3 | #7–10 | `consume`, default cost, per-key `Map`, `ensureBucket` |
| 4 | #11–15 | Denial branch, `retryAfterMs` math + `Math.ceil`, `lastChecked`, float tokens, clock injection wired up |
| 5 | #16–19 | Refill linearity / cap / accumulation / deny-storm invariant — all green without code changes (regression armor) |
| 6 | #20–21 | `request_exceeds_capacity` branch + cost validation. **Refactor**: extracted `validatePositiveInteger` / `validatePositiveFinite` |
| 7 | #22–24 | Per-key isolation, independent refill timing, clock determinism — green without code changes |
