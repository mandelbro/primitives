export type VectorMatch = {
  id: string;
  score: number;
  metadata: object;
};

export type VectorDbClient = {
  search(
    index: string,
    query: string,
    topK: number,
    filter?: Record<string, unknown>,
    namespace?: string,
  ): Promise<{ matches: VectorMatch[] }>;
};

export type Opts = {
  client: VectorDbClient;
};

// Codes for wrapper-mediated (operational) errors only.
// Input validation errors are SDK-mediated and use the SDK's flat text envelope
// — they do not carry an application-level code.
export type ErrorCode =
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

// Thrown by VectorDbClient.search to signal HTTP-shaped upstream errors.
// retryAfter (seconds) propagates the upstream Retry-After header value;
// only set on 429.
export class UpstreamError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(
    status: number,
    message: string,
    options?: { retryAfter?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'UpstreamError';
    this.status = status;
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}
