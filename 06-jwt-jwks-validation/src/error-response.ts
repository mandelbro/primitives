import type { Response } from 'express';

export interface AuthErrorEnvelope {
  realm: string;
  error?: string;
  errorDescription?: string;
}

// RFC 7235 quoted-string: DQUOTE and BACKSLASH must be escaped via
// quoted-pair (\" and \\). CR/LF/NUL are header-injection vectors and
// are rejected at construction time (see validate-options + require-scope)
// rather than escaped — there's no escaping that recovers a safe header.
function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

function buildHeader(envelope: AuthErrorEnvelope): string {
  const params: string[] = [`realm="${escapeQuoted(envelope.realm)}"`];
  if (envelope.error) {
    params.push(`error="${escapeQuoted(envelope.error)}"`);
    if (envelope.errorDescription) {
      params.push(`error_description="${escapeQuoted(envelope.errorDescription)}"`);
    }
  }
  return `Bearer ${params.join(', ')}`;
}

export function send401(res: Response, envelope: AuthErrorEnvelope): void {
  res.set('WWW-Authenticate', buildHeader(envelope));
  res.status(401).end();
}

export function send403(res: Response, envelope: AuthErrorEnvelope): void {
  res.set('WWW-Authenticate', buildHeader(envelope));
  res.status(403).end();
}
