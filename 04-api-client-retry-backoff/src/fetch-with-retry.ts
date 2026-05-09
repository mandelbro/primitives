import type { RetryOptions, RetryRequest, RetryResponse } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 30_000;

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const defaultRetryOn = (status: number): boolean =>
  status === 429 || status === 503 || status === 504;

const defaultIsIdempotent = (req: RetryRequest): boolean =>
  IDEMPOTENT_METHODS.has(req.method.toUpperCase());

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const isAbortError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: unknown }).name === 'AbortError';

const parseRetryAfter = (
  headers: Record<string, string>,
  now: number,
): number | undefined => {
  const raw = headers['retry-after']?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  if (!/[a-zA-Z]/.test(raw)) return undefined;
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - now);
};

export function fetchWithRetry(
  opts?: RetryOptions,
): (req: RetryRequest) => Promise<RetryResponse> {
  const fetchImpl = opts?.fetch;
  if (!fetchImpl) {
    throw new Error('fetchWithRetry: opts.fetch is required (no default yet)');
  }
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = opts?.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts?.maxMs ?? DEFAULT_MAX_MS;
  const retryOn = opts?.retryOn ?? defaultRetryOn;
  const isIdempotent = opts?.isIdempotent ?? defaultIsIdempotent;
  const sleep = opts?.sleep ?? defaultSleep;
  const clock = opts?.clock ?? Date.now;

  function getComputedMs(attempt: number): number {
    return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  }

  return async (req) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isLastAttempt = attempt === maxAttempts;

      let res: RetryResponse;
      try {
        res = await fetchImpl(req);
      } catch (err) {
        // Abort always propagates unchanged — never retried, never re-wrapped.
        if (isAbortError(err)) throw err;
        // Non-idempotent network errors are unsafe to retry.
        if (!isIdempotent(req)) throw err;
        // Out of attempts on an idempotent network error → propagate.
        if (isLastAttempt) throw err;
        await sleep(getComputedMs(attempt), req.signal);
        continue;
      }

      if (!retryOn(res.status) || !isIdempotent(req) || isLastAttempt)
        return res;
      const retryAfterMs = parseRetryAfter(res.headers, clock());
      const delayMs = Math.min(retryAfterMs ?? getComputedMs(attempt), maxMs);
      await sleep(delayMs, req.signal);
    }
    throw new Error('fetchWithRetry: maxAttempts must be >= 1');
  };
}
