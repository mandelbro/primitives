export type BufferedBody = Uint8Array | string | undefined;

export type RetryRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: BufferedBody;
  signal?: AbortSignal;
};

export type RetryResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type RetryOptions = {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  retryOn?: (status: number) => boolean;
  isIdempotent?: (req: RetryRequest) => boolean;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetch?: (req: RetryRequest) => Promise<RetryResponse>;
};
