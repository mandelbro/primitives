import type { RequestHandler } from './types.js';
import { send403 } from './error-response.js';

// requireScope intentionally has no realm option; the spec doesn't surface one
// on its public API. Hardcoding "api" matches the jwtAuth default. If consumers
// need a custom realm here, that's a spec extension to consider.
const DEFAULT_REALM = 'api';

export function requireScope(scope: string): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      throw new Error('requireScope: req.auth is not set — did you mount jwtAuth?');
    }
    if (!req.auth.scope.includes(scope)) {
      send403(res, {
        realm: DEFAULT_REALM,
        error: 'insufficient_scope',
        errorDescription: `requires ${scope}`,
      });
      return;
    }
    next();
  };
}
