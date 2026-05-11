import { describe, expect, it } from 'vitest';
import { errors as joseErrors } from 'jose';
import { mapJoseError } from '../src/map-jose-error.js';

describe('mapJoseError', () => {
  describe('known jose error classes (§7 wire format)', () => {
    it('JWTExpired → "token expired"', () => {
      const err = new joseErrors.JWTExpired('exp claim timestamp check failed', { exp: 1 }, 'exp');
      expect(mapJoseError(err)).toBe('token expired');
    });

    it('JWTClaimValidationFailed with claim="iss" → "invalid issuer"', () => {
      const err = new joseErrors.JWTClaimValidationFailed('iss mismatch', {}, 'iss', 'check_failed');
      expect(mapJoseError(err)).toBe('invalid issuer');
    });

    it('JWTClaimValidationFailed with claim="aud" → "invalid audience"', () => {
      const err = new joseErrors.JWTClaimValidationFailed('aud mismatch', {}, 'aud', 'check_failed');
      expect(mapJoseError(err)).toBe('invalid audience');
    });

    it('JWTClaimValidationFailed with claim="nbf" → "token not yet valid"', () => {
      const err = new joseErrors.JWTClaimValidationFailed('nbf in future', {}, 'nbf', 'check_failed');
      expect(mapJoseError(err)).toBe('token not yet valid');
    });

    it('JWSSignatureVerificationFailed → "invalid signature"', () => {
      const err = new joseErrors.JWSSignatureVerificationFailed();
      expect(mapJoseError(err)).toBe('invalid signature');
    });

    it('JWSInvalid → "malformed"', () => {
      const err = new joseErrors.JWSInvalid();
      expect(mapJoseError(err)).toBe('malformed');
    });
  });

  describe('unmapped error fallthroughs', () => {
    // Regression: §7 has no row for "unrecognized claim". The signature DID
    // verify (we got past sig check to claim validation), so reporting
    // "invalid signature" would lie to the bearer about forgery. Degrade
    // safely to "malformed" — same envelope as JWSInvalid.
    it('JWTClaimValidationFailed with unmapped claim → "malformed" (not "invalid signature")', () => {
      const err = new joseErrors.JWTClaimValidationFailed(
        'iat invalid',
        {},
        'iat',
        'check_failed',
      );
      expect(mapJoseError(err)).toBe('malformed');
    });

    it('JWTClaimValidationFailed with no claim → "malformed"', () => {
      const err = new joseErrors.JWTClaimValidationFailed('generic claim failure', {});
      expect(mapJoseError(err)).toBe('malformed');
    });

    // Regression: any future jose error class, or any unexpected throw from
    // verify(), must not silently masquerade as a forged-signature failure.
    it('unknown Error subclass → "malformed"', () => {
      expect(mapJoseError(new Error('unexpected jose internal'))).toBe('malformed');
      expect(mapJoseError(new TypeError('weird'))).toBe('malformed');
      expect(mapJoseError(new RangeError('weirder'))).toBe('malformed');
    });

    it('non-Error throwable → "malformed"', () => {
      expect(mapJoseError('not even an error')).toBe('malformed');
      expect(mapJoseError(undefined)).toBe('malformed');
      expect(mapJoseError(null)).toBe('malformed');
      expect(mapJoseError({ message: 'plain object' })).toBe('malformed');
    });
  });
});
