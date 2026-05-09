import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../src/fetch-with-retry.js';
import type { RetryRequest, RetryResponse } from '../src/types.js';

const okResponse = (): RetryResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode('{"ok":true}'),
});

const responseWithStatus = (status: number): RetryResponse => ({
  status,
  headers: {},
  body: new Uint8Array(),
});

const getRequest = (): RetryRequest => ({
  method: 'GET',
  url: 'https://api.example.com/v1/things',
  headers: {},
  body: undefined,
});

const noSleep = (): Promise<void> => Promise.resolve();

describe('fetchWithRetry', () => {
  describe('success path', () => {
    it('returns the response without retrying when fetch resolves 200 on first attempt', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse());

      const send = fetchWithRetry({ fetch: fetchMock });
      const res = await send(getRequest());

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('retries on transient status', () => {
    it.each([429, 503, 504])(
      'retries once after %i and returns 200',
      async (status) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(responseWithStatus(status))
          .mockResolvedValueOnce(okResponse());

        const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
        const res = await send(getRequest());

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
    );
  });

  describe('backoff', () => {
    it('produces 250/500/1000/2000ms across attempts 1-4 with default baseMs=250', async () => {
      const fetchMock = vi.fn().mockResolvedValue(responseWithStatus(503));
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: sleepMock,
        maxAttempts: 5,
      });
      await send(getRequest());

      expect(sleepMock).toHaveBeenCalledTimes(4);
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([
        250, 500, 1000, 2000,
      ]);
    });

    it('clamps backoff to maxMs (baseMs=10000, maxMs=15000 → 10000/15000/15000)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(responseWithStatus(503));
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: sleepMock,
        baseMs: 10_000,
        maxMs: 15_000,
        maxAttempts: 4,
      });
      await send(getRequest());

      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([
        10_000, 15_000, 15_000,
      ]);
    });
  });

  describe('honors Retry-After', () => {
    const transientWith = (
      headers: Record<string, string>,
    ): RetryResponse => ({
      status: 429,
      headers,
      body: new Uint8Array(),
    });

    it('uses delta-seconds value from Retry-After header instead of computed backoff', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(transientWith({ 'retry-after': '5' }))
        .mockResolvedValueOnce(okResponse());
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });
      const res = await send(getRequest());

      expect(res.status).toBe(200);
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock.mock.calls[0]?.[0]).toBe(5000);
    });

    it('treats Retry-After: 0 as retry-immediately', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(transientWith({ 'retry-after': '0' }))
        .mockResolvedValueOnce(okResponse());
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });
      await send(getRequest());

      expect(sleepMock.mock.calls[0]?.[0]).toBe(0);
    });

    it.each(['   ', 'foo', '5.5', '-3'])(
      'falls back to computed backoff when Retry-After is %j',
      async (raw) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(transientWith({ 'retry-after': raw }))
          .mockResolvedValueOnce(okResponse());
        const sleepMock = vi.fn().mockResolvedValue(undefined);

        const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });
        await send(getRequest());

        expect(sleepMock.mock.calls[0]?.[0]).toBe(250);
      },
    );

    it('clamps Retry-After to maxMs', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(transientWith({ 'retry-after': '60' }))
        .mockResolvedValueOnce(okResponse());
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });
      await send(getRequest());

      expect(sleepMock.mock.calls[0]?.[0]).toBe(30_000);
    });

    it('honors Retry-After when sent as an HTTP-date in the future', async () => {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      const future = new Date(now + 7000).toUTCString();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(transientWith({ 'retry-after': future }))
        .mockResolvedValueOnce(okResponse());
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: sleepMock,
        clock: () => now,
      });
      await send(getRequest());

      expect(sleepMock.mock.calls[0]?.[0]).toBe(7000);
    });

    it('clamps a past Retry-After HTTP-date to 0', async () => {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      const past = new Date(now - 5000).toUTCString();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(transientWith({ 'retry-after': past }))
        .mockResolvedValueOnce(okResponse());
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: sleepMock,
        clock: () => now,
      });
      await send(getRequest());

      expect(sleepMock.mock.calls[0]?.[0]).toBe(0);
    });

    it('consumes one attempt against maxAttempts (server cannot pin client past budget)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(transientWith({ 'retry-after': '5' }));
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: sleepMock,
        maxAttempts: 3,
      });
      const res = await send(getRequest());

      expect(res.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('multiple retries before success', () => {
    it('retries through a mix of retriable statuses and returns 200', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(responseWithStatus(429))
        .mockResolvedValueOnce(responseWithStatus(504))
        .mockResolvedValueOnce(okResponse());

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
      const res = await send(getRequest());

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('abandons retry mid-sequence on non-retriable status', () => {
    it('stops retrying when a non-retriable status arrives and returns it', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(429))
        .mockResolvedValueOnce(responseWithStatus(400));

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
      const res = await send(getRequest());

      expect(res.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry exhaustion', () => {
    it('returns the last response when every attempt returns a retriable status', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(429))
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(responseWithStatus(504));

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: noSleep,
        maxAttempts: 3,
      });
      const res = await send(getRequest());

      expect(res.status).toBe(504);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('abort signal', () => {
    it('forwards req.signal to sleep so abort can interrupt pending backoff', async () => {
      // Create the abort controller to pass into the request.
      const ac = new AbortController();
      // Mock the fetch to resolve with a 503 and then a 200.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(okResponse());
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      // Create the fetchWithRetry function with the mock fetch and sleep.
      const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });
      // Send the request with the abort controller's signal.
      await send({ ...getRequest(), signal: ac.signal });

      // Get the request's signal from the sleep mock.
      const fetchWithRetryRequestSignal = sleepMock.mock.calls[0]?.[1];

      // Expect the sleep mock to have been called once.
      expect(sleepMock).toHaveBeenCalledTimes(1);
      // Expect the request's signal to be the same as the abort controller's signal.
      expect(fetchWithRetryRequestSignal).toBe(ac.signal);
    });

    it('rejects with the AbortError DOMException when sleep rejects mid-backoff', async () => {
      const abortError = new DOMException('aborted', 'AbortError');
      const fetchMock = vi.fn().mockResolvedValue(responseWithStatus(503));
      const sleepMock = vi.fn().mockRejectedValue(abortError);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });

      // The wrapper must propagate the rejection unchanged — same reference,
      // not a wrapped or re-thrown error.
      await expect(send(getRequest())).rejects.toBe(abortError);
      // And it must not have started a follow-up attempt after the abort.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('defaultSleep honors signal that is already aborted (no sleep override)', async () => {
      // No `sleep` in opts — exercises the production defaultSleep path.
      const ac = new AbortController();
      ac.abort();
      const fetchMock = vi.fn().mockResolvedValue(responseWithStatus(503));

      const send = fetchWithRetry({ fetch: fetchMock, maxAttempts: 2, baseMs: 1 });

      // With the bug: sleep ignores signal, attempt 2 runs, promise resolves
      // with 503. With the fix: sleep rejects immediately, attempt 2 never
      // happens, promise rejects.
      await expect(
        send({ ...getRequest(), signal: ac.signal }),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects with the AbortError DOMException when fetch rejects mid-request', async () => {
      const abortError = new DOMException('aborted', 'AbortError');
      const fetchMock = vi.fn().mockRejectedValue(abortError);
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: sleepMock });

      // Same propagation contract on the fetch path: the wrapper must not
      // swallow the abort, retry on it, or re-wrap the DOMException.
      await expect(send(getRequest())).rejects.toBe(abortError);
      // No retry, no sleep — abort wins immediately.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });
  });

  describe('idempotency gating on transient status', () => {
    it('does not retry POST on 503 by default (POST is non-idempotent)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(responseWithStatus(503));

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
      const res = await send({
        ...getRequest(),
        method: 'POST',
        body: 'payload',
      });

      expect(res.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries POST on 503 when caller overrides isIdempotent (e.g. Idempotency-Key)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(okResponse());

      const send = fetchWithRetry({
        fetch: fetchMock,
        sleep: noSleep,
        isIdempotent: () => true,
      });
      const res = await send({
        ...getRequest(),
        method: 'POST',
        body: 'payload',
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('body replay across retries', () => {
    it('passes the same string body to fetch on every attempt', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(okResponse());
      const body = '{"id":"abc","payload":"123"}';

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
      await send({ ...getRequest(), method: 'PUT', body });

      const bodies = fetchMock.mock.calls.map(
        (c) => (c[0] as RetryRequest).body,
      );
      expect(bodies).toEqual([body, body, body]);
    });

    it('passes the same Uint8Array body to fetch on every attempt', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(responseWithStatus(503))
        .mockResolvedValueOnce(okResponse());
      const body = new TextEncoder().encode('binary-payload');

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
      await send({ ...getRequest(), method: 'PUT', body });

      // toEqual deep-compares Uint8Array element-wise, so this catches byte
      // drift without pinning reference identity (defensive cloning is fine).
      const bodies = fetchMock.mock.calls.map(
        (c) => (c[0] as RetryRequest).body,
      );
      expect(bodies).toEqual([body, body]);
    });
  });

  describe('request integrity across retries', () => {
    it('does not mutate the input request and does not leak response headers into later attempts', async () => {
      // First-attempt response carries header noise that a buggy wrapper might
      // accidentally splice into the request for the second attempt.
      const noisyTransient: RetryResponse = {
        status: 503,
        headers: {
          'x-server-injected': 'should-not-leak',
          'set-cookie': 'session=abc',
        },
        body: new Uint8Array(),
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(noisyTransient)
        .mockResolvedValueOnce(okResponse());

      const req: RetryRequest = {
        method: 'GET',
        url: 'https://api.example.com/v1/things',
        headers: { authorization: 'Bearer token-123' },
        body: undefined,
      };
      const reqSnapshot = structuredClone(req);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
      await send(req);

      // Caller's request object is unchanged after the call.
      expect(req).toEqual(reqSnapshot);

      // Both attempts saw the original headers — no response leakage.
      const firstAttemptHeaders = (
        fetchMock.mock.calls[0]?.[0] as RetryRequest
      ).headers;
      const secondAttemptHeaders = (
        fetchMock.mock.calls[1]?.[0] as RetryRequest
      ).headers;
      expect(firstAttemptHeaders).toEqual({
        authorization: 'Bearer token-123',
      });
      expect(secondAttemptHeaders).toEqual({
        authorization: 'Bearer token-123',
      });
    });
  });

  describe('network errors', () => {
    it.each(['GET', 'HEAD', 'PUT', 'DELETE'])(
      'retries after a network error for idempotent method %s',
      async (method) => {
        const networkError = new TypeError('fetch failed');
        const fetchMock = vi
          .fn()
          .mockRejectedValueOnce(networkError)
          .mockResolvedValueOnce(okResponse());

        const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
        const res = await send({ ...getRequest(), method });

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
    );

    it('does not retry after a network error for POST (non-idempotent)', async () => {
      const networkError = new TypeError('fetch failed');
      const fetchMock = vi.fn().mockRejectedValue(networkError);

      const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });

      await expect(
        send({ ...getRequest(), method: 'POST', body: 'payload' }),
      ).rejects.toBe(networkError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('does not retry on non-retriable status', () => {
    it.each([400, 404, 500, 502])(
      'returns %i without retrying',
      async (status) => {
        const fetchMock = vi.fn().mockResolvedValue(responseWithStatus(status));

        const send = fetchWithRetry({ fetch: fetchMock, sleep: noSleep });
        const res = await send(getRequest());

        expect(res.status).toBe(status);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });
});
