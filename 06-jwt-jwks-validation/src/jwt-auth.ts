import { jwtVerify } from 'jose';
import type { AuthContext, JwtAuthOptions, RequestHandler } from './types.js';
import { validateOptions } from './validate-options.js';
import {
  decodeHeader,
  MalformedTokenError,
  MissingKidError,
  UnsupportedAlgError,
} from './decode-header.js';
import { JwksCache, JwksUpstreamError } from './jwks-cache.js';
import { mapJoseError } from './map-jose-error.js';
import { normalizeScope } from './scope.js';
import { send401 } from './error-response.js';

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_SKEW_SEC = 60;
const DEFAULT_REALM = 'api';

/**
 * Build an Express middleware that validates RS256 JWTs against a JWKS
 * endpoint and populates `req.auth` on success.
 *
 * **Each call instantiates its own JwksCache.** Mount `jwtAuth(opts)`
 * once per `jwksUri` and share the returned handler across routes —
 * calling `jwtAuth(opts)` per-route works correctly but creates one
 * independent cache per mount, each making its own JWKS fetches. The
 * extra fetches are silent: the wire response is identical, so only
 * upstream load (or a `fetcher.callCount` assertion in tests) reveals
 * the duplication.
 *
 * Throws synchronously on invalid options (see `validate-options.ts`
 * and the spec's Error States section).
 */
export function jwtAuth(opts: JwtAuthOptions): RequestHandler {
  validateOptions(opts);

  const realm = opts.realm ?? DEFAULT_REALM;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const clockSkewSec = opts.clockSkewSec ?? DEFAULT_SKEW_SEC;
  const now = opts.now ?? Date.now;
  const fetcher = opts.fetcher ?? globalThis.fetch;

  const cache = new JwksCache({
    jwksUri: opts.jwksUri,
    cacheTtlMs,
    fetcher,
    now,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  return async (req, res, next) => {
    if (req.auth !== undefined) {
      throw new Error('jwtAuth: req.auth is already set — did you mount jwtAuth twice?');
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      send401(res, { realm });
      return;
    }

    const parts = authHeader.split(' ');
    const scheme = parts[0];
    if (!scheme || scheme.toLowerCase() !== 'bearer') {
      send401(res, {
        realm,
        error: 'invalid_request',
        errorDescription: 'expected Bearer scheme',
      });
      return;
    }
    const rest = parts.slice(1);
    if (rest.length !== 1 || rest[0] === '') {
      send401(res, { realm, error: 'invalid_token', errorDescription: 'malformed' });
      return;
    }
    const token = rest[0]!;

    let header;
    try {
      header = decodeHeader(token);
    } catch (err) {
      if (err instanceof UnsupportedAlgError) {
        send401(res, { realm, error: 'invalid_token', errorDescription: 'unsupported alg' });
        return;
      }
      if (err instanceof MissingKidError) {
        send401(res, { realm, error: 'invalid_token', errorDescription: 'unknown kid' });
        return;
      }
      if (err instanceof MalformedTokenError) {
        send401(res, { realm, error: 'invalid_token', errorDescription: 'malformed' });
        return;
      }
      throw err;
    }

    let key;
    try {
      key = await cache.getKey(header.kid);
    } catch (err) {
      if (err instanceof JwksUpstreamError) {
        send401(res, { realm, error: 'invalid_token', errorDescription: 'unknown kid' });
        return;
      }
      throw err;
    }
    if (!key) {
      send401(res, { realm, error: 'invalid_token', errorDescription: 'unknown kid' });
      return;
    }

    let claims: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        audience: opts.audience,
        issuer: opts.issuer,
        clockTolerance: clockSkewSec,
        currentDate: new Date(now()),
      });
      claims = result.payload as Record<string, unknown>;
    } catch (err) {
      send401(res, {
        realm,
        error: 'invalid_token',
        errorDescription: mapJoseError(err),
      });
      return;
    }

    const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
    const auth: AuthContext = {
      sub,
      scope: normalizeScope(claims['scope']),
      claims,
    };
    req.auth = auth;
    next();
  };
}
