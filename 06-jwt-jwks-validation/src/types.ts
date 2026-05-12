export interface JwtAuthOptions {
  /** Full URL of the JWKS endpoint. */
  jwksUri: string;
  /** Required `aud` claim. If array, token's aud must match at least one. */
  audience: string | string[];
  /** Required `iss` claim, exact match. */
  issuer: string;
  /** JWKS cache TTL. Default 600_000 (10 minutes). */
  cacheTtlMs?: number;
  /** Clock-skew tolerance for exp/nbf, in seconds. Default 60. */
  clockSkewSec?: number;
  /** WWW-Authenticate realm. Default "api". */
  realm?: string;
  /** Time source. Default Date.now. */
  now?: () => number;
  /** HTTP fetcher. Default globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Observability hook for JWKS fetch failures (server-side only). */
  logger?: (msg: string, ctx: Record<string, unknown>) => void;
}

export interface AuthContext {
  sub: string;
  scope: string[];
  claims: Record<string, unknown>;
}

export interface RequireScopeOptions {
  /**
   * WWW-Authenticate realm. Default "api". Match `jwtAuth`'s realm so 401
   * and 403 challenges on the same protected resource share a realm (RFC
   * 7235). Mismatched realms confuse compliant client retry logic.
   */
  realm?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
