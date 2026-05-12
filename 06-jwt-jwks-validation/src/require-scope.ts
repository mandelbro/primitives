import type { RequestHandler, RequireScopeOptions } from './types.js';
import { send403 } from './error-response.js';

const DEFAULT_REALM = 'api';

// Both the realm option and the scope arg flow into the WWW-Authenticate
// header (scope via `requires <scope>` in the error_description). CR, LF,
// and NUL are header-injection vectors with no quoted-string escaping that
// recovers a safe header — reject at construction time.
const HEADER_UNSAFE = /[\r\n\0]/;

export function requireScope(scope: string, opts: RequireScopeOptions = {}): RequestHandler {
  if (HEADER_UNSAFE.test(scope)) {
    throw new Error('requireScope: scope must not contain CR, LF, or NUL');
  }
  if (opts.realm !== undefined && HEADER_UNSAFE.test(opts.realm)) {
    throw new Error('requireScope: realm must not contain CR, LF, or NUL');
  }
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
