import type { JwtAuthOptions } from './types.js';

export function validateOptions(opts: JwtAuthOptions): void {
  if (!opts.jwksUri) {
    throw new Error('jwtAuth: jwksUri is required');
  }
  try {
    new URL(opts.jwksUri);
  } catch {
    throw new Error('jwtAuth: jwksUri must be a parseable URL');
  }
  if (opts.audience === undefined || opts.audience === null) {
    throw new Error('jwtAuth: audience is required');
  }
  if (typeof opts.audience === 'string' && opts.audience === '') {
    throw new Error('jwtAuth: audience must not be empty');
  }
  if (Array.isArray(opts.audience) && opts.audience.length === 0) {
    throw new Error('jwtAuth: audience must not be empty');
  }
  if (!opts.issuer) {
    throw new Error('jwtAuth: issuer is required');
  }
  if (opts.cacheTtlMs !== undefined && opts.cacheTtlMs <= 0) {
    throw new Error('jwtAuth: cacheTtlMs must be positive');
  }
  if (opts.clockSkewSec !== undefined && opts.clockSkewSec < 0) {
    throw new Error('jwtAuth: clockSkewSec must be non-negative');
  }
  // realm flows verbatim into the WWW-Authenticate header. CR/LF/NUL are
  // header-injection vectors with no quoted-string escaping that recovers
  // a safe header — reject loudly at construction. DQUOTE and BACKSLASH
  // are handled separately by buildHeader's escapeQuoted.
  if (opts.realm !== undefined && /[\r\n\0]/.test(opts.realm)) {
    throw new Error('jwtAuth: realm must not contain CR, LF, or NUL');
  }
}
