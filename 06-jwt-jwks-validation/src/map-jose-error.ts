import { errors as joseErrors } from 'jose';

/**
 * Map a jose verification error to a §7 wire-format error_description.
 *
 * Fallthroughs degrade to "malformed" rather than "invalid signature":
 * a claim-validation failure means the signature DID verify, so labeling
 * it as a forgery would mislead bearers and corrupt log triage. Unknown
 * error classes likewise default to "malformed" — the conservative
 * envelope that says "something is structurally wrong" without making
 * cryptographic claims.
 */
export function mapJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = (err as { claim?: string }).claim;
    if (claim === 'iss') return 'invalid issuer';
    if (claim === 'aud') return 'invalid audience';
    if (claim === 'nbf') return 'token not yet valid';
    return 'malformed';
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'invalid signature';
  if (err instanceof joseErrors.JWSInvalid) return 'malformed';
  return 'malformed';
}
