import { describe, it, expect } from 'vitest';

import { TokenBucketRateLimiter } from '../src/rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  // Spec tests #1–5: construction validation. Invalid config is a programmer
  // error — fail loudly at the constructor boundary, not silently at runtime.
  describe('construction validation', () => {
    // #1
    it('constructs successfully with a valid config', () => {
      expect(() => new TokenBucketRateLimiter(10, 4)).not.toThrow();
    });

    // #2 — capacity must be > 0
    it.each([0, -1, -100])(
      'throws when capacity is not positive (%s)',
      (capacity) => {
        expect(() => new TokenBucketRateLimiter(capacity, 4)).toThrow(
          RangeError,
        );
      },
    );

    // #3 — capacity must be an integer
    it.each([1.5, 0.5, Math.PI])(
      'throws when capacity is non-integer (%s)',
      (capacity) => {
        expect(() => new TokenBucketRateLimiter(capacity, 4)).toThrow(
          RangeError,
        );
      },
    );

    // #4 — refillRatePerSecond must be > 0 (fractional rates allowed)
    it.each([0, -1, -0.5])(
      'throws when refillRatePerSecond is not positive (%s)',
      (rate) => {
        expect(() => new TokenBucketRateLimiter(10, rate)).toThrow(RangeError);
      },
    );

    // #5 — neither numeric config value may be non-finite
    it.each([NaN, Infinity, -Infinity])(
      'throws when capacity is non-finite (%s)',
      (capacity) => {
        expect(() => new TokenBucketRateLimiter(capacity, 4)).toThrow(
          RangeError,
        );
      },
    );

    it.each([NaN, Infinity, -Infinity])(
      'throws when refillRatePerSecond is non-finite (%s)',
      (rate) => {
        expect(() => new TokenBucketRateLimiter(10, rate)).toThrow(RangeError);
      },
    );
  });

  describe('a fresh bucket', () => {
    // Spec test #6 — peek() on a never-seen key returns the bucket as full.
    // This is the smallest test that proves the class exists, the constructor
    // accepts (capacity, refillRatePerSecond), peek is on the public API, and
    // the "fresh bucket starts full" invariant holds. No clock advancement
    // needed yet — that comes in later refill tests.
    it('reports capacity remaining when peeked before any consume', () => {
      const limiter = new TokenBucketRateLimiter(10, 4);

      expect(limiter.peek('tenant-a')).toEqual({
        remaining: 10,
        capacity: 10,
      });
    });
  });

  describe('debit semantics', () => {
    // #7 — first consume on a never-seen key. Exercises lazy bucket
    // creation + default-cost behavior in a single shot.
    it('debits from a full bucket on the first consume for a never-seen key', () => {
      const limiter = new TokenBucketRateLimiter(10, 4);

      expect(limiter.consume('tenant-a')).toEqual({
        ok: true,
        remaining: 9,
      });
    });

    // #8 — explicit cost of 1. Pinned separately from the default so a
    // future change to the default doesn't silently break this contract.
    it('debits exactly 1 token when cost is explicitly 1', () => {
      const limiter = new TokenBucketRateLimiter(10, 4);

      expect(limiter.consume('tenant-a', 1)).toEqual({
        ok: true,
        remaining: 9,
      });
    });

    // #9 — cost weighting. Drives the cost parameter being honored, not
    // hard-coded to 1.
    it('debits exactly 3 tokens when cost is 3', () => {
      const limiter = new TokenBucketRateLimiter(10, 4);

      expect(limiter.consume('tenant-a', 3)).toEqual({
        ok: true,
        remaining: 7,
      });
    });

    // #10 — successive consumes drain to exactly 0. Forces real per-key
    // state (a single field would survive #7–9 but cannot survive this
    // when combined with later isolation tests).
    it('drains the bucket to exactly 0 over successive consumes', () => {
      const limiter = new TokenBucketRateLimiter(3, 4);

      expect(limiter.consume('tenant-a')).toEqual({ ok: true, remaining: 2 });
      expect(limiter.consume('tenant-a')).toEqual({ ok: true, remaining: 1 });
      expect(limiter.consume('tenant-a')).toEqual({ ok: true, remaining: 0 });
    });

    // #11 — consume on a drained bucket is denied with reason rate_limited.
    // Forces the denial branch of ConsumeResult into existence.
    it('denies consume on an empty bucket with reason rate_limited', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(1, 4, clock);

      limiter.consume('tenant-a'); // drain

      expect(limiter.consume('tenant-a')).toMatchObject({
        ok: false,
        reason: 'rate_limited',
      });
    });

    // #12 — denial is non-mutating. A deny-storm must not double-debit.
    it('does not change remaining tokens on a rate_limited denial', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(1, 4, clock);

      limiter.consume('tenant-a'); // drain to 0
      expect(limiter.peek('tenant-a').remaining).toBe(0);

      limiter.consume('tenant-a'); // denied
      expect(limiter.peek('tenant-a').remaining).toBe(0);
    });
  });

  describe('retryAfterMs correctness', () => {
    // #13 — the canonical worked example from the spec.
    it('reports retryAfterMs of 250 for 1 token needed at 4 tokens/sec', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(1, 4, clock);

      limiter.consume('tenant-a'); // drain

      expect(limiter.consume('tenant-a')).toEqual({
        ok: false,
        reason: 'rate_limited',
        retryAfterMs: 250,
        message: 'Rate limit exceeded. Retry in 250 ms.',
      });
    });

    // #14 — non-exact divisions round UP. Rounding down would invite the
    // caller to retry a millisecond early and be denied again.
    it('rounds retryAfterMs up for non-exact divisions', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(1, 3, clock);

      limiter.consume('tenant-a'); // drain

      // 1 token needed at 3 tokens/sec → 333.333… ms → ceil = 334
      expect(limiter.consume('tenant-a')).toMatchObject({
        ok: false,
        reason: 'rate_limited',
        retryAfterMs: 334,
      });
    });

    // #15 — the retry hint is honest end-to-end. Forces the refill machinery
    // into existence: clock storage, lastChecked tracking, and the lazy
    // refill calculation in consume.
    it('succeeds on the next consume after the clock advances by retryAfterMs', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 4, clock);

      for (let i = 0; i < 10; i++) {
        limiter.consume('tenant-a');
      }

      const denied = limiter.consume('tenant-a');
      if (denied.ok) {
        throw new Error('expected rate_limited denial after draining');
      }
      if (denied.reason !== 'rate_limited') {
        throw new Error(`expected rate_limited, got ${denied.reason}`);
      }

      now += denied.retryAfterMs;

      expect(limiter.consume('tenant-a')).toEqual({
        ok: true,
        remaining: 0,
      });
    });
  });

  describe('refill behavior', () => {
    // #16 — refill is lazy and proportional to elapsed time. The fact that
    // the bucket only refills when we ask (consume/peek) and never on its
    // own is implicit: the test uses an injected clock, so no real time
    // passing could affect the result. If a setInterval were running, it
    // would not see the injected clock.
    it('refills lazily at the configured rate per second', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 4, clock);

      for (let i = 0; i < 10; i++) limiter.consume('tenant-a');
      // tokens=0, lastChecked=0

      now = 1000; // advance one second
      expect(limiter.peek('tenant-a').remaining).toBe(4);
    });

    // #17 — refill is capped at capacity. Without the cap, a long-idle
    // bucket would accumulate unbounded credit and the next request would
    // see a burst far above what the rate allows.
    it('caps refill at capacity even when elapsed time would yield more', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 4, clock);

      for (let i = 0; i < 10; i++) limiter.consume('tenant-a');

      // 10 seconds at 4 tokens/sec = 40 tokens of would-be refill, capped at 10.
      now = 10_000;
      expect(limiter.peek('tenant-a').remaining).toBe(10);
    });

    // #18 — sub-token credit accumulates across calls. If refill were
    // floored on each call, every 100ms tick would add Math.floor(0.4) = 0
    // and the bucket would never recover. Float storage is what makes
    // the rate limiter honor its configured rate at fine-grained intervals.
    it('accumulates sub-token refill credit across calls', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 4, clock);

      for (let i = 0; i < 10; i++) limiter.consume('tenant-a');

      // Each peek at a 100ms tick adds 0.4 tokens of refill — sub-token.
      for (let t = 100; t <= 500; t += 100) {
        now = t;
        limiter.peek('tenant-a');
      }

      // 5 × 0.4 = 2.0 whole tokens accumulated.
      expect(limiter.peek('tenant-a').remaining).toBe(2);
    });

    // #19 — lastChecked must update on denied calls too. If it didn't,
    // the second 100ms tick below would compute elapsed=200 from the
    // original drain time and double-count refill, allowing a request
    // that should still be denied. The "load-bearing" rule from spec
    // decision #5.
    it('updates lastChecked on denied calls so deny-storms do not freeze refill', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 2, clock);

      for (let i = 0; i < 10; i++) limiter.consume('tenant-a'); // drain

      // Each tick yields 0.4 tokens of refill — sub-cost. Every call
      // should be denied, and each call's refill should only see the
      // 100ms since the previous call, not the original drain.
      now = 250;
      expect(limiter.consume('tenant-a', 2).ok).toBe(false);
      expect(limiter.peek('tenant-a').remaining).toBe(0);

      now = 500;
      expect(limiter.consume('tenant-a', 2).ok).toBe(false);
      expect(limiter.peek('tenant-a').remaining).toBe(1);
    });
  });

  describe('permanent rejection', () => {
    // #20a — cost > capacity is permanent: even on a full bucket, the
    // request is unsatisfiable. Forces the third arm of the ConsumeResult
    // discriminated union into existence.
    it('returns request_exceeds_capacity when cost > capacity on a full bucket', () => {
      const limiter = new TokenBucketRateLimiter(10, 4);

      expect(limiter.consume('tenant-a', 20)).toEqual({
        ok: false,
        reason: 'request_exceeds_capacity',
        message: 'Request cost (20) exceeds bucket capacity (10).',
      });
    });

    // #20b — permanent rejection takes precedence over rate_limited.
    // On an empty bucket, cost=1 would be rate_limited; cost=20 is still
    // request_exceeds_capacity. The check happens regardless of current
    // token state, and there is no retryAfterMs (toEqual would fail if
    // one leaked into the result).
    it('returns request_exceeds_capacity regardless of current tokens, with no retryAfterMs', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 4, clock);

      for (let i = 0; i < 10; i++) limiter.consume('tenant-a');

      expect(limiter.consume('tenant-a', 20)).toEqual({
        ok: false,
        reason: 'request_exceeds_capacity',
        message: 'Request cost (20) exceeds bucket capacity (10).',
      });
    });
  });

  describe('cost validation', () => {
    // #21 — invalid cost is a programmer error, not a runtime denial.
    // Throw at the boundary so callers can't accidentally treat malformed
    // input as a soft-rejected request.
    it.each([0, -1, -100])(
      'throws when cost is not positive (%s)',
      (cost) => {
        const limiter = new TokenBucketRateLimiter(10, 4);

        expect(() => limiter.consume('tenant-a', cost)).toThrow(RangeError);
      },
    );

    it.each([1.5, 0.5, Math.PI])(
      'throws when cost is non-integer (%s)',
      (cost) => {
        const limiter = new TokenBucketRateLimiter(10, 4);

        expect(() => limiter.consume('tenant-a', cost)).toThrow(RangeError);
      },
    );

    it.each([NaN, Infinity, -Infinity])(
      'throws when cost is non-finite (%s)',
      (cost) => {
        const limiter = new TokenBucketRateLimiter(10, 4);

        expect(() => limiter.consume('tenant-a', cost)).toThrow(RangeError);
      },
    );
  });

  describe('per-key isolation', () => {
    // #22 — Activity on key A must not change key B's bucket. Tests both
    // directions in one shot: A drained does not deny B; B's consume does
    // not refill or otherwise alter A.
    it('isolates token state between keys', () => {
      const limiter = new TokenBucketRateLimiter(3, 4);

      for (let i = 0; i < 3; i++) limiter.consume('tenant-a');

      expect(limiter.consume('tenant-b')).toEqual({
        ok: true,
        remaining: 2,
      });
      expect(limiter.peek('tenant-a').remaining).toBe(0);
    });

    // #23 — Each key carries its own lastChecked; refill on A is computed
    // from A's history, not from whenever B was last touched. If buckets
    // accidentally shared a single timestamp, A's refill at t=1000 would
    // be computed from t=500 (B's creation) instead of t=0 (A's drain),
    // yielding 2 tokens instead of 4.
    it('refills each key independently of activity on other keys', () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 4, clock);

      // tenant-a: drained at t=0; A's lastChecked = 0
      for (let i = 0; i < 10; i++) limiter.consume('tenant-a');

      // tenant-b: bucket created at t=500; B's lastChecked = 500
      now = 500;
      limiter.consume('tenant-b');

      // At t=1000, A has had 1000ms of refill at 4 tokens/sec = 4 tokens.
      // If A and B shared lastChecked, this would be only 2.
      now = 1000;
      expect(limiter.peek('tenant-a').remaining).toBe(4);
      expect(limiter.peek('tenant-b').remaining).toBe(10);
    });
  });

  describe('clock determinism', () => {
    // #24 — The limiter reads time exclusively from the injected clock.
    // Real time elapses during the setTimeout, but the fixed clock stays
    // at 0, so no refill happens. If consume/peek/applyRefill accidentally
    // called performance.now() anywhere, the high refill rate (100/sec)
    // would put several tokens back in the bucket during the 50ms wait.
    it('uses only the injected clock, not real time', async () => {
      let now = 0;
      const clock = (): number => now;
      const limiter = new TokenBucketRateLimiter(10, 100, clock);

      for (let i = 0; i < 10; i++) limiter.consume('tenant-a');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(limiter.peek('tenant-a').remaining).toBe(0);
    });
  });
});
