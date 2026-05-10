import { importJWK, type JWK, type KeyLike } from 'jose';

export interface JwksCacheOptions {
  jwksUri: string;
  cacheTtlMs: number;
  fetcher: typeof fetch;
  now: () => number;
  logger?: (msg: string, ctx: Record<string, unknown>) => void;
}

interface CacheEntry {
  key: KeyLike | Uint8Array;
  fetchedAt: number;
}

export class JwksUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksUpstreamError';
  }
}

export class JwksCache {
  private entries = new Map<string, CacheEntry>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: JwksCacheOptions) {}

  async getKey(kid: string): Promise<KeyLike | Uint8Array | null> {
    const cached = this.lookupFresh(kid);
    if (cached) {
      return cached;
    }
    await this.refresh();
    return this.lookupFresh(kid);
  }

  private lookupFresh(kid: string): KeyLike | Uint8Array | null {
    const entry = this.entries.get(kid);
    if (!entry) return null;
    if (this.opts.now() - entry.fetchedAt >= this.opts.cacheTtlMs) {
      return null;
    }
    return entry.key;
  }

  private async refresh(): Promise<void> {
    // Single-flight: concurrent unknown-kid requests await the same promise per §4.
    // .finally clears on both resolve and reject — clearing on reject is essential,
    // otherwise one transient endpoint failure poisons the cache.
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doFetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFetch(): Promise<void> {
    let response: Response;
    try {
      response = await this.opts.fetcher(this.opts.jwksUri);
    } catch (err) {
      this.opts.logger?.('jwks_fetch_error', {
        url: this.opts.jwksUri,
        error: (err as Error).message,
      });
      throw new JwksUpstreamError('JWKS fetch failed');
    }
    if (!response.ok) {
      this.opts.logger?.('jwks_fetch_error', {
        url: this.opts.jwksUri,
        status: response.status,
      });
      throw new JwksUpstreamError(`JWKS fetch returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      this.opts.logger?.('jwks_fetch_error', {
        url: this.opts.jwksUri,
        error: (err as Error).message,
      });
      throw new JwksUpstreamError('JWKS body is not JSON');
    }
    if (!body || typeof body !== 'object' || !Array.isArray((body as { keys?: unknown[] }).keys)) {
      this.opts.logger?.('jwks_fetch_error', {
        url: this.opts.jwksUri,
        error: 'malformed JWKS body',
      });
      throw new JwksUpstreamError('Malformed JWKS body');
    }
    // Refresh REPLACES the cache with the current JWKS response — keys no longer
    // advertised are evicted. Spec §3.
    const fetchedAt = this.opts.now();
    const next = new Map<string, CacheEntry>();
    for (const raw of (body as { keys: unknown[] }).keys) {
      if (!raw || typeof raw !== 'object') continue;
      const jwk = raw as JWK;
      // Filter to RSA + (use="sig" or use absent) per §11.
      if (jwk.kty !== 'RSA') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      if (typeof jwk.kid !== 'string' || jwk.kid === '') continue;
      try {
        const key = (await importJWK(jwk, 'RS256')) as KeyLike;
        next.set(jwk.kid, { key, fetchedAt });
      } catch {
        // Unimportable key — skip.
      }
    }
    this.entries = next;
  }
}
