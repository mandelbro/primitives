import type { RequestHandler, RequireScopeOptions } from './types.js';
import { send403 } from './error-response.js';

const DEFAULT_REALM = 'api';

export function requireScope(scope: string, opts: RequireScopeOptions = {}): RequestHandler {
  const realm = opts.realm ?? DEFAULT_REALM;
  return (req, res, next) => {
    if (!req.auth) {
      throw new Error('requireScope: req.auth is not set — did you mount jwtAuth?');
    }
    if (!req.auth.scope.includes(scope)) {
      send403(res, {
        realm,
        error: 'insufficient_scope',
        errorDescription: `requires ${scope}`,
      });
      return;
    }
    next();
  };
}
