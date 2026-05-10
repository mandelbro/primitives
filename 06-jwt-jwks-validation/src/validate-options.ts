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
}
