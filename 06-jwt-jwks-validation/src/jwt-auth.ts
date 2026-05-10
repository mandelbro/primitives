import type { JwtAuthOptions, RequestHandler } from './types.js';
import { validateOptions } from './validate-options.js';

export function jwtAuth(opts: JwtAuthOptions): RequestHandler {
  validateOptions(opts);
  return (_req, res, _next) => {
    res.status(500).end();
  };
}
