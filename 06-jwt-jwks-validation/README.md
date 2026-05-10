# Express JWT/JWKS Validation Middleware

Express middleware that validates RS256 JWTs against a JWKS endpoint with key
rotation, kid-keyed caching, and RFC 6750 compliant error envelopes. Built
with TypeScript, tested with Vitest + supertest, runtime dependency on `jose`.

## Specification

See [express-jwt-jwks-validation-spec.md](express-jwt-jwks-validation-spec.md)
for the spec — public API, design decisions, behavior-driven test plan.

## Quick start

```bash
pnpm install
pnpm test          # vitest run — 62 cases across 9 behavioral test files
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
```

## Layout

| Path | What it is |
|---|---|
| `express-jwt-jwks-validation-spec.md` | Source of truth — public API, §6 pipeline, §7 wire-format table, §13 rotation flow |
| `src/jwt-auth.ts` | `jwtAuth(opts)` factory — pipeline orchestrator |
| `src/require-scope.ts` | `requireScope(scope)` factory |
| `src/jwks-cache.ts` | Per-kid JWKS cache: TTL, single-flight refresh, replace-on-refresh |
| `src/decode-header.ts` | Pre-decode JWT header per §5 (belt-and-suspenders alg pinning) |
| `src/error-response.ts` | RFC 6750 `WWW-Authenticate` envelope construction |
| `src/scope.ts` | §3 normalization of the standard `scope` claim |
| `src/validate-options.ts` | Synchronous factory-time options validation |
| `src/types.ts` | `JwtAuthOptions`, `AuthContext`, `Request.auth` augmentation |
| `tests/fixtures.ts` | RS256 key gen, controllable now/fetcher, mountApp helper |
| `tests/wire-format.test.ts` | Parameterized over §7 envelope table |
| `tests/rotation.test.ts` | §13 zero-downtime rotation walked end-to-end |

Read the spec first. The implementation follows it; the tests pin it.

## Public API at a glance

```typescript
import express from 'express';
import { jwtAuth, requireScope } from 'express-jwt-jwks-validation';

const app = express();

app.use(jwtAuth({
  jwksUri: 'https://idp.example/.well-known/jwks.json',  // required
  issuer: 'https://idp.example/',                         // required
  audience: 'urn:my:api',                                 // required, string | string[]
  // All optional — defaults shown
  cacheTtlMs: 600_000,        // 10 minutes
  clockSkewSec: 60,
  realm: 'api',
  now: Date.now,
  fetcher: globalThis.fetch,
  logger: undefined,           // (msg, ctx) => void; called on JWKS upstream failures
}));

app.get('/admin', requireScope('admin'), (req, res) => {
  // req.auth: { sub, scope: string[], claims: Record<string, unknown> }
  res.json({ user: req.auth!.sub });
});
```

`req.auth.claims` is the full payload from jose verbatim. `req.auth.sub` and
`req.auth.scope` are projections for convenience; consumers can read IdP-
specific claims (`scp`, `permissions`, etc.) directly from `claims`.

## Design highlights

These are the non-obvious choices. Full rationale lives in the spec.

- **Hard-pin RS256.** `alg: none` and `alg: HS256` are rejected at header
  pre-decode, before signature verify. Algorithm-confusion is eliminated
  by configuration, not by hoping jose's options stick. The pipeline-
  ordering test (B1) makes this observable: an `alg=none` token with
  expired `exp` and tampered signature fails with `"unsupported alg"`.

- **Custom JwksCache + jose for verify.** `jose.jwtVerify` does the
  cryptography; the cache primitive is ours: per-kid entries, TTL,
  single-flight refresh, `.finally`-clear on both resolve and reject so
  one transient endpoint failure doesn't poison the cache. Cleanup-on-
  reject is the §4 "essential" line, regression-tested by D4.

- **Replace-on-refresh, not merge.** Refreshing the JWKS replaces the
  entire entries map. Keys retired upstream become unresolvable on the
  next refresh — that's the whole point of §13's rotation guarantee.

- **Asymmetric skew boundaries** (inherited from jose v5):
  - `exp <= now − tolerance` → expired
  - `nbf > now + tolerance` → not yet valid
  - So `exp = now − skew` is **expired** (boundary exclusive of validity)
    while `nbf = now + skew` is **valid** (boundary inclusive). We don't
    paper over the asymmetry; both edges are pinned in `skew-boundaries.test.ts`.

- **Strict RFC 6750 §3 mode for missing creds.** No `error=` parameter on
  the bare `WWW-Authenticate: Bearer realm=…` for missing-creds 401s.
  Error codes are reserved for credentials that were presented and
  rejected.

- **Programmer errors throw, not 4xx.** `requireScope` without `jwtAuth`
  upstream, or `jwtAuth` running with `req.auth` already set, both throw
  synchronously and surface to Express's error handler. These are wiring
  bugs that should fail loud at integration time.

- **No proactive prefetch, no timers.** First request after cold start
  triggers the first JWKS fetch. Avoids timer drift, startup races with
  the IdP, and redundant fetches when no requests are arriving.

## TDD progression

Spec-first; tests written one batch at a time before each green slice.

| Batch | Group | Tests | Notes |
|---|---|---|---|
| 0 | Setup | — | Fixtures: RS256 key gen, fakeFetcher, fakeNow, mountApp |
| 1 | H | 8 | Options validation throws synchronously at factory call |
| 2 | A1, A2 | 3 | Happy path + missing creds — drives full pipeline thin slice |
| 3 | A3 | 15 | §7 wire-format envelope table parameterized |
| 4 | B1, A4 | 3 | Pipeline ordering + aud flexibility |
| 5 | C1-C3, E1 | 12 | Skew boundaries + scope normalization table |
| 6 | D1, D2, D7 | 3 | Cache hit / miss / TTL |
| 7 | D3, D4 | 2 | Concurrent kid-miss + cleanup-on-reject |
| 8 | D5, D6, D8, D9 | 10 | Eviction, instance isolation, upstream failure, key filtering |
| 9 | F1, F2, G1, G2 | 5 | requireScope + wiring errors |
| 10 | I1 | 1 | Zero-downtime rotation walked end-to-end |

Most batches went green on first test run because earlier batches forced
the pipeline into a complete shape. The two real fixes were:

- **Empty signature segment** must be allowed by `decodeHeader` so
  `alg=none` reaches the alg check rather than failing at "malformed."
- **Trailing-char base64url tampering** is unreliable for the
  invalid-signature test; mid-segment tamper is.

See [DEVIATIONS.md](DEVIATIONS.md) for items that need a review decision
before merge.
