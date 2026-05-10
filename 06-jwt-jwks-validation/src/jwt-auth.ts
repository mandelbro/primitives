import type { JwtAuthOptions, RequestHandler } from './types.js';

export function jwtAuth(_opts: JwtAuthOptions): RequestHandler {
  throw new Error('jwtAuth: not implemented');
}
