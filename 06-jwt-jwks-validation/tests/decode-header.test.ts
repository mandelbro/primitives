import { describe, expect, it } from 'vitest';
import {
  decodeHeader,
  MalformedTokenError,
  MissingKidError,
  UnsupportedAlgError,
} from '../src/decode-header.js';
import { craftRawJwt } from './fixtures.js';

describe('decodeHeader', () => {
  it('happy path: RS256 with kid and non-empty signature returns {alg, kid}', () => {
    const jwt = craftRawJwt({ alg: 'RS256', kid: 'k1' }, { sub: 'x' }, 'sig');
    expect(decodeHeader(jwt)).toEqual({ alg: 'RS256', kid: 'k1' });
  });

  // B1 invariant (spec §6 step 5): an unsigned (alg=none) token must
  // reach the alg check and produce "unsupported alg" — not "malformed".
  // The empty-signature carve-out in decodeHeader exists for exactly this.
  it('alg=none with empty signature: UnsupportedAlgError (B1 invariant)', () => {
    const jwt = craftRawJwt({ alg: 'none', kid: 'k1' }, { sub: 'x' }, '');
    expect(() => decodeHeader(jwt)).toThrow(UnsupportedAlgError);
  });

  // Sibling pin: the alg check fires before the empty-signature check.
  // alg=HS256 + empty sig must produce "unsupported alg", not "malformed".
  it('alg=HS256 with empty signature: UnsupportedAlgError (alg check ordered before empty-sig check)', () => {
    const jwt = craftRawJwt({ alg: 'HS256', kid: 'k1' }, { sub: 'x' }, '');
    expect(() => decodeHeader(jwt)).toThrow(UnsupportedAlgError);
  });

  // THE NEW PIN: an RS256 token with an empty signature segment must be
  // rejected by the pre-decode as "malformed" rather than falling through
  // to jose. Today it falls through and jose maps it to "malformed" via
  // JWSInvalid; that's the same wire label by accident of jose's error
  // class, not by spec contract. Pinning it here makes the rejection
  // independent of jose's internal taxonomy.
  it('alg=RS256 with empty signature: MalformedTokenError (pre-decode rejects, not jose)', () => {
    const jwt = craftRawJwt({ alg: 'RS256', kid: 'k1' }, { sub: 'x' }, '');
    expect(() => decodeHeader(jwt)).toThrow(MalformedTokenError);
  });

  // Ordering pin: empty-sig check is ordered BEFORE the kid check. A
  // token missing both the signature and the kid produces "malformed",
  // not "unknown kid" — empty-sig is the more fundamental structural
  // defect and wins.
  it('alg=RS256 with empty sig and missing kid: MalformedTokenError (empty-sig ordered before kid check)', () => {
    const jwt = craftRawJwt({ alg: 'RS256' }, { sub: 'x' }, '');
    expect(() => decodeHeader(jwt)).toThrow(MalformedTokenError);
  });

  // Regression pin: the kid check still works when the signature is present.
  it('alg=RS256 with non-empty sig and missing kid: MissingKidError', () => {
    const jwt = craftRawJwt({ alg: 'RS256' }, { sub: 'x' }, 'sig');
    expect(() => decodeHeader(jwt)).toThrow(MissingKidError);
  });
});
