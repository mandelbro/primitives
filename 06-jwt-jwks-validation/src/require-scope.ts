import type { RequestHandler } from './types.js';

export function requireScope(_scope: string): RequestHandler {
  throw new Error('requireScope: not implemented');
}
