// Token Bucket Rate Limiter — public contract.
// Implementation is grown via TDD; see ../rate-limiter-spec.md for the spec.

import { performance } from 'node:perf_hooks';

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
  consume(key: string, cost?: number): ConsumeResult;
  peek(key: string): PeekResult;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface BucketRecord {
  // Float; sub-token credit accumulates across refills (decision #6).
  tokens: number;
  // ms timestamp from the injected clock; updated on every refill (#5).
  lastChecked: number;
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function validatePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${name} must be a positive finite number, got ${value}`,
    );
  }
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSecond: number;
  private readonly clock: Clock;
  private readonly buckets = new Map<string, BucketRecord>();

  constructor(
    capacity: number,
    refillRatePerSecond: number,
    clock: Clock = () => performance.now(),
  ) {
    validatePositiveInteger('capacity', capacity);
    validatePositiveFinite('refillRatePerSecond', refillRatePerSecond);
    this.capacity = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
    this.clock = clock;
  }

  consume(key: string, cost: number = 1): ConsumeResult {
    validatePositiveInteger('cost', cost);
    if (cost > this.capacity) {
      return {
        ok: false,
        reason: 'request_exceeds_capacity',
        message: `Request cost (${cost}) exceeds bucket capacity (${this.capacity}).`,
      };
    }

    const bucket = this.ensureBucket(key);
    this.applyRefill(bucket);

    if (Math.floor(bucket.tokens) >= cost) {
      bucket.tokens -= cost;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    }

    const tokensNeeded = cost - bucket.tokens;
    const retryAfterMs = Math.ceil(
      (tokensNeeded / this.refillRatePerSecond) * 1000,
    );
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterMs,
      message: `Rate limit exceeded. Retry in ${retryAfterMs} ms.`,
    };
  }

  peek(key: string): PeekResult {
    const bucket = this.ensureBucket(key);
    this.applyRefill(bucket);
    return { remaining: Math.floor(bucket.tokens), capacity: this.capacity };
  }

  private ensureBucket(key: string): BucketRecord {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, lastChecked: this.clock() };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private applyRefill(bucket: BucketRecord): void {
    const now = this.clock();
    const elapsed = now - bucket.lastChecked;
    const added = (elapsed * this.refillRatePerSecond) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + added);
    bucket.lastChecked = now;
  }
}
