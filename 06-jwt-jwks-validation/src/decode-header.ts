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
  // 3-segment shape per RFC 7519. Header and payload must be present; the
  // signature segment is allowed to be empty so unsigned (alg:none) tokens
  // reach the alg check below and produce "unsupported alg" rather than
  // "malformed". This is a load-bearing distinction — see spec §6/B1.
  if (segments.length !== 3 || segments[0] === '' || segments[1] === '') {
    throw new MalformedTokenError();
  }
  // Validate the base64url charset explicitly rather than relying on
  // Node's `Buffer.from(..., 'base64url')` leniency. Node's decoder
  // silently accepts some non-alphabet bytes and produces a possibly-empty
  // buffer; the explicit check makes rejection deterministic and removes
  // dependence on a behavior that could change across Node versions.
  if (!/^[A-Za-z0-9_-]+$/.test(segments[0]!)) {
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
  // The empty-signature carve-out above exists only to let alg=none reach
  // the alg check (B1 invariant). Once we know alg=RS256, an empty
  // signature segment is structurally malformed and must be rejected
  // here, not relied on jose's internal error taxonomy to catch.
  if (segments[2] === '') {
    throw new MalformedTokenError();
  }
  if (typeof header['kid'] !== 'string' || header['kid'] === '') {
    throw new MissingKidError();
  }
  return { alg: header['alg'], kid: header['kid'] };
}
