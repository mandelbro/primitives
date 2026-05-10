import type { Response } from 'express';

export interface AuthErrorEnvelope {
  realm: string;
  error?: string;
  errorDescription?: string;
}

function buildHeader(envelope: AuthErrorEnvelope): string {
  const params: string[] = [`realm="${envelope.realm}"`];
  if (envelope.error) {
    params.push(`error="${envelope.error}"`);
    if (envelope.errorDescription) {
      params.push(`error_description="${envelope.errorDescription}"`);
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
