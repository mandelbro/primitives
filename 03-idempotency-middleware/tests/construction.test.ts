import { describe, it, expect } from 'vitest';
import {
  createIdempotencyMiddleware,
  type IdempotencyOptions,
  type Store,
} from '../src/index.js';

const noopStore: Store = {
  async get() {
    return null;
  },
  async set() {
    return;
  },
};

const noopScope = () => 'global';

const construct = (opts: unknown) =>
  createIdempotencyMiddleware(opts as IdempotencyOptions);

describe('createIdempotencyMiddleware — construction & validation', () => {
  // T1
  it('constructs with required options only and returns a RequestHandler', () => {
    const mw = createIdempotencyMiddleware({
      store: noopStore,
      scope: noopScope,
    });
    expect(typeof mw).toBe('function');
    // Express RequestHandler signature is (req, res, next)
    expect(mw.length).toBe(3);
  });

  // T2
  it('constructs with all options provided', () => {
    const mw = createIdempotencyMiddleware({
      store: noopStore,
      scope: noopScope,
      ttlMs: 1_000,
      clock: () => 0,
      trackedMethods: new Set(['POST', 'PUT']),
    });
    expect(typeof mw).toBe('function');
  });

  // T3
  it('throws when opts.store is missing', () => {
    expect(() => construct({ scope: noopScope })).toThrow(/store/i);
  });

  // T4
  it('throws when opts.scope is missing', () => {
    expect(() => construct({ store: noopStore })).toThrow(/scope/i);
  });

  // T5 — non-positive or non-finite ttlMs
  describe('throws when ttlMs is non-positive or non-finite', () => {
    it.each([0, -1, -100, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN])(
      'rejects ttlMs=%s',
      (bad) => {
        expect(() =>
          construct({ store: noopStore, scope: noopScope, ttlMs: bad }),
        ).toThrow(/ttlMs/);
      },
    );
  });

  // T5a (gap) — clock provided but not a function
  it('throws when clock is provided but not a function', () => {
    expect(() =>
      construct({ store: noopStore, scope: noopScope, clock: 123 }),
    ).toThrow(/clock/);
  });

  // T5b (gap) — trackedMethods provided but not iterable
  it('throws when trackedMethods is provided but not iterable', () => {
    expect(() =>
      construct({ store: noopStore, scope: noopScope, trackedMethods: 42 }),
    ).toThrow(/trackedMethods/);
  });

  // T5c (gap) — trackedMethods contains a non-string entry
  it('throws when trackedMethods contains a non-string entry', () => {
    expect(() =>
      construct({
        store: noopStore,
        scope: noopScope,
        trackedMethods: new Set(['POST', 123]),
      }),
    ).toThrow(/trackedMethods/);
  });
});
