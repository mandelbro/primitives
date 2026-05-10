// Normalize the standard `scope` claim per spec §3.
// IdP-specific shapes (scp, permissions) are intentionally left untouched on
// req.auth.claims for consumers to read directly.
export function normalizeScope(claim: unknown): string[] {
  if (typeof claim === 'string') {
    return claim.split(/\s+/u).filter((s) => s.length > 0);
  }
  if (Array.isArray(claim)) {
    return claim.filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  return [];
}
