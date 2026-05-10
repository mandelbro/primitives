export interface JwtHeader {
  alg: string;
  kid: string;
}

export class MalformedTokenError extends Error {
  constructor() {
    super('malformed');
    this.name = 'MalformedTokenError';
  }
}

export class UnsupportedAlgError extends Error {
  constructor() {
    super('unsupported alg');
    this.name = 'UnsupportedAlgError';
  }
}

export class MissingKidError extends Error {
  constructor() {
    super('unknown kid');
    this.name = 'MissingKidError';
  }
}

// Pre-decode the JWT header per spec §5: split into three segments, base64url-decode
// the header, parse as JSON, then enforce alg=RS256 and kid presence ourselves.
// This belt-and-suspenders alg check (§6 step 5) must precede signature verify and
// claims validation — the security ordering is observable through B1.
export function decodeHeader(token: string): JwtHeader {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((s) => s === '')) {
    throw new MalformedTokenError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(segments[0]!, 'base64url').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    throw new MalformedTokenError();
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new MalformedTokenError();
  }
  const header = parsed as Record<string, unknown>;
  if (typeof header['alg'] !== 'string') {
    throw new MalformedTokenError();
  }
  if (header['alg'] !== 'RS256') {
    throw new UnsupportedAlgError();
  }
  if (typeof header['kid'] !== 'string' || header['kid'] === '') {
    throw new MissingKidError();
  }
  return { alg: header['alg'], kid: header['kid'] };
}
