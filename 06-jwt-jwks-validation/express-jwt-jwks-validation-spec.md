# Express JWT/JWKS Validation Middleware

## What is it?

An Express middleware that validates RS256 JWTs against a JWKS endpoint. The
public surface is `jwtAuth(opts)` which returns a `RequestHandler`. On success
it populates `req.auth = { sub, scope, claims }` and calls `next()`. On failure
it returns 401 with a `WWW-Authenticate: Bearer …` header per RFC 6750. JWKS
are cached with a TTL, refreshed on `kid` miss with a single in-flight promise,
and support key rotation without a redeploy.

A companion `requireScope(scope)` middleware enforces per-route authorization
by reading `req.auth.scope`. It runs after `jwtAuth` and returns 403 with
`error="insufficient_scope"` on failure.

## Public API

```ts
import type { RequestHandler } from 'express';

export interface JwtAuthOptions {
  /** Full URL of the JWKS endpoint. */
  jwksUri: string;
  /** Required `aud` claim. If array, token's aud must match at least one. */
  audience: string | string[];
  /** Required `iss` claim, exact match. */
  issuer: string;
  /** JWKS cache TTL. Default 600_000 (10 minutes). */
  cacheTtlMs?: number;
  /** Clock-skew tolerance for exp/nbf, in seconds. Default 60. */
  clockSkewSec?: number;
  /** WWW-Authenticate realm. Default "api". */
  realm?: string;
  /** Time source. Default Date.now. */
  now?: () => number;
  /** HTTP fetcher. Default globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Observability hook for JWKS fetch failures (server-side only). */
  logger?: (msg: string, ctx: Record<string, unknown>) => void;
}

export interface AuthContext {
  sub: string;
  scope: string[];
  claims: Record<string, unknown>;
}

export interface RequireScopeOptions {
  /** WWW-Authenticate realm. Default "api". Match `jwtAuth`'s realm so
   * 401 and 403 challenges on the same protected resource share a realm
   * (RFC 7235). */
  realm?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function jwtAuth(opts: JwtAuthOptions): RequestHandler;
export function requireScope(scope: string, opts?: RequireScopeOptions): RequestHandler;
```

`claims` is the full decoded JWT payload verbatim from jose, including standard
claims (`sub`, `iss`, `aud`, `exp`, `iat`, `nbf`, `scope`). `sub` and `scope`
on `AuthContext` are projections for convenience; `claims.sub === sub` and
`claims.scope` is the raw scope claim before normalization.

**Scope normalization.** `req.auth.scope` is normalized from `claims.scope`:

- `string` → split on whitespace, drop empty entries.
- `string[]` → drop non-string and empty-string elements.
- Anything else (missing, `null`, number, object) → `[]`.

Only the standard `scope` claim is normalized. IdP-specific names (`scp`,
`permissions`, etc.) are left untouched on `req.auth.claims` — consumers read
them directly.

## Design Decisions

### 1. Hard-pin RS256

Reject `alg: none`, `alg: HS256`, anything else. Algorithm-confusion is a known
JWT failure mode; we eliminate it by configuration. Passed to jose via
`algorithms: ['RS256']`.

### 2. Missing Authorization header — strict RFC 6750

Per RFC 6750 §3, when the request lacks any credentials, return 401 with
`WWW-Authenticate: Bearer realm="..."` and no error code. Error codes are
reserved for credentials that were presented and rejected.

### 3. JWKS caching

Cache JWKS keys by `kid`, default TTL 10 minutes. Cache hit: verify against the
cached JWK. Cache miss (kid absent or entry past TTL): refresh JWKS once,
retry. **Refresh replaces the cache with the current JWKS response — keys no
longer advertised are evicted.** If still missing: 401 "unknown kid". Prevents
JWKS-endpoint DoS via malformed-token storms.

### 4. Refresh debounce

Each `jwtAuth(opts)` call instantiates its own `JwksCache`. At most one
in-flight JWKS fetch per cache instance. Concurrent unknown-kid requests on a
given instance await the same promise stored on the cache. The promise is
cleared on **both** resolve and reject — clearing on reject is essential,
otherwise one transient endpoint failure poisons the cache.

Two `jwtAuth` instances pointing at the same `jwksUri` operate independent
caches and fetch independently. This is wasteful but correct; production code
should mount a single instance per `jwksUri` and reuse it across routes.

### 5. Library choice — jose for verify, custom JwksCache

Use `jose` for RSA signature verification and claim validation. Implement the
`JwksCache` ourselves (TTL, kid-miss refresh, in-flight debounce,
cleanup-on-reject) — this is the interesting primitive. `jose.jwtVerify` is
invoked with a `getKey` callback that hits our cache.

We **pre-decode the JWT header** (split on `.`, base64url-decode segment 1,
parse as JSON) before invoking `jose` to enforce structure, `alg`, and `kid`
checks ourselves and produce our error envelope deterministically. This also
serves as belt-and-suspenders for §1: even if `jose.jwtVerify` is misconfigured,
the explicit `alg !== 'RS256'` check rejects algorithm-confusion attacks. The
payload (segment 2) and signature (segment 3) are not pre-decoded; jose handles
those during verification. We pass `algorithms: ['RS256']` to jose regardless.
Test B2 validates this is genuine redundancy — with the pre-decode mocked
out, the jose-side check alone still rejects RSA-family hash confusion
(RS384/RS512/PS256 against an RSA verifier key). The WebCrypto algorithm
binding on the imported key is **not** a structural defense here; jose v5
will verify across hashes if `algorithms` is absent.

### 6. Verification pipeline order

First failure short-circuits.

1. Authorization header present
2. Bearer scheme
3. Bearer payload structure (single non-empty token)
4. JWT structure: split on `.` into three segments; base64url-decode header (segment 1); parse header as JSON. Any failure → "malformed"
5. Header `alg === "RS256"`
6. Header `kid` present
7. JWKS resolution (cache → refresh once → cache)
8. RSA signature verify
9. Claim validation: `exp`, `nbf` (with skew), `iss`, `aud`

`iat` is read but not validated.

**Skew boundary semantics.** Inherited from jose's `clockTolerance` behavior,
which we pass through verbatim as `clockTolerance: clockSkewSec`. The two
boundaries are **asymmetric** because jose uses different comparators for
`exp` vs `nbf`:

- `exp` boundary is **exclusive** of validity (`exp <= now − skew` →
  expired). A token whose `exp` equals `now − skew` is the first expired
  second; `now − skew + 1` is the latest still-valid second.
- `nbf` boundary is **inclusive** of validity (`nbf > now + skew` → not
  yet valid). A token whose `nbf` equals `now + skew` is still valid;
  `now + skew + 1` is the first not-yet-valid second.

This asymmetry is a property of jose v5; we do not paper over it because
that would mean second-guessing the underlying library on a security-
sensitive boundary.

### 7. RFC 6750 wire format

All auth failures → HTTP 401. Scope failures → HTTP 403. `invalid_request`
returned as 401 (operational consistency; RFC's SHOULD-400 is latitude).

| Failure | HTTP | error | error_description |
|---|---|---|---|
| Missing Authorization | 401 | — | — |
| Non-Bearer scheme | 401 | invalid_request | "expected Bearer scheme" |
| Empty / extra parts | 401 | invalid_token | "malformed" |
| JWT decode fails | 401 | invalid_token | "malformed" |
| alg not RS256 | 401 | invalid_token | "unsupported alg" |
| Missing kid | 401 | invalid_token | "unknown kid" |
| Unknown kid (after refresh) | 401 | invalid_token | "unknown kid" |
| JWKS upstream failure | 401 | invalid_token | "unknown kid" |
| Signature invalid | 401 | invalid_token | "invalid signature" |
| exp past (after skew) | 401 | invalid_token | "token expired" |
| nbf future (after skew) | 401 | invalid_token | "token not yet valid" |
| iss mismatch | 401 | invalid_token | "invalid issuer" |
| aud mismatch | 401 | invalid_token | "invalid audience" |
| Insufficient scope | 403 | insufficient_scope | "requires <scope>" |

### 8. Scope enforcement is a separate middleware

`jwtAuth` does authentication; `requireScope` does authorization. `jwtAuth`
populates `req.auth` once at app/router scope. `requireScope(scope, opts?)`
reads it per route. Single-scope semantics; multi-scope is deferred.

`requireScope` accepts an optional `realm` (default `"api"`) so consumers
that customize `jwtAuth({ realm: ... })` can pass the same string here. The
realm has to be set in both places because the middlewares are independent
by design — but RFC 7235 expects challenges on the same protected resource
to share a realm, so consumers who configure one realm should configure the
other to match. F3 pins this behavior end-to-end.

### 9. JWKS upstream failure handling

On JWKS endpoint 5xx, network error, or malformed JWKS body during a kid-miss
refresh: collapse to 401 invalid_token "unknown kid". Don't leak infra signal
to bearers. Log via `opts.logger` if provided. The in-flight promise rejects
so the next request triggers a fresh refresh.

### 10. Clock and fetcher injection (DI)

`now` drives both cache TTL bookkeeping and jose's `currentDate` (passed as
`new Date(now())`). `fetcher` defaults to `globalThis.fetch`. Both are
constructor-time options, matching the `01-rate-limiter` pattern.

### 11. JWKS key filtering

Filter the JWKS response to `kty: "RSA"` and (`use: "sig"` or `use` absent).
Defensive against endpoints publishing keys we can't/shouldn't use.

### 12. Programmer-error vs runtime-failure

Two conditions throw rather than returning 4xx, because they indicate wiring
bugs:

- `requireScope` mounted without `jwtAuth` (`req.auth` undefined when it runs).
- `jwtAuth` runs against a request where `req.auth` is already set.

### 13. Zero-downtime key rotation

Key rotation requires no restart and no manual intervention. The mechanism
combines per-kid caching (§3), kid-miss refresh (§3), in-flight debounce (§4),
JWKS-replaces-cache semantics (§3), and per-entry TTL expiry.

**Planned rotation flow.** The IdP advertises both old and new keys during an
overlap window, then begins signing new tokens with the new kid:

1. Tokens with the old kid continue to hit the cache → verify normally.
2. The first token with the new kid triggers a kid-miss → one in-flight
   refresh → JWKS now contains both keys → both cached → token verifies.
3. Subsequent old-kid and new-kid tokens both hit the cache. No interruption.
4. When the IdP removes the old key from JWKS, the next refresh (triggered
   either by TTL expiry or by an unrelated kid-miss) evicts it from the cache.
   Tokens still bearing the retired kid then receive `401 "unknown kid"`.

**Emergency revocation.** When the IdP removes a compromised kid from JWKS
out-of-band, the worst-case exposure window is one `cacheTtlMs` (default 10
minutes). On TTL expiry the entry is treated as a miss, refresh runs, the
revoked kid is absent, and verification fails. A kid-miss for any other kid
during the window also triggers a refresh and tightens the window further.

**No proactive prefetch.** We do not refresh on a timer or warm the cache at
startup. First request after cold start triggers the first fetch. This avoids
timer drift, startup-time races with the JWKS endpoint, and redundant fetches
when no requests are arriving.

## Error States

See §7 for failure → wire mapping.

**Programmer errors (thrown):**

- `Error("requireScope: req.auth is not set — did you mount jwtAuth?")`
- `Error("jwtAuth: req.auth is already set — did you mount jwtAuth twice?")`

**Options validation (thrown at `jwtAuth(opts)` call site):**

- `jwksUri` missing or not a parseable URL
- `audience` empty string or empty array
- `issuer` missing
- `cacheTtlMs <= 0`, `clockSkewSec < 0`

## Test Plan

Tests are organized by **observable behavior**, not pipeline stage. Each group
asserts a contract a consumer of the middleware would recognize. Where the §7
wire-format table or the §3 scope-normalization table enumerates inputs, the
test parameterizes over the table rather than splitting into per-row tests —
that way, adding a new failure mode forces a row in the table rather than an
orphaned test someone might forget.

**Harness.** Groups A, F, and I drive the middleware through a real
`express()` app via `supertest`, because the wire format (status, headers,
body) is the contract. Groups B, C, D, E, G, H call the `RequestHandler`
through a thin fake `req`/`res`/`next` triple so the cache primitive and
boundary semantics can be exercised without supertest's overhead.

**Fixtures.** `tests/fixtures.ts` provides:
- `generateKeyPair(kid)` — RS256 key pair plus public JWK
- `signWithKey(privateKey, kid, payload)` — mint an RS256 JWT
- `jwks(keys)` — JWKS document body
- `fakeNow()` — controllable `() => number`
- `fakeFetcher()` — controllable `typeof fetch` with call counter and
  per-URL response queue, used to assert refresh count and stub upstream
  failures
- `mountApp(opts)` — builds an `express()` app with `jwtAuth(opts)` and a
  protected route, used by Groups A/F/I

### Group A — Authentication contract (consumer-facing wire format)

- **A1** Valid token → 200; `req.auth = { sub, scope, claims }`; `next()`
  called. `claims` is the full payload verbatim from jose; `claims.sub ===
  req.auth.sub`; `claims.scope` is the raw scope claim and `req.auth.scope`
  is the normalized array.
- **A2** Missing `Authorization` header → 401; `WWW-Authenticate: Bearer
  realm="api"`; no `error` parameter (RFC 6750 §3 strict mode).
- **A3** Presented-but-rejected credentials produce a structured 401 with
  the exact envelope from §7. Parameterized over the §7 table:

  | Input | error | error_description |
  |---|---|---|
  | `Basic abc` | `invalid_request` | "expected Bearer scheme" |
  | `Bearer ` (empty) | `invalid_token` | "malformed" |
  | `Bearer a b c` (extra parts) | `invalid_token` | "malformed" |
  | two-segment JWT | `invalid_token` | "malformed" |
  | non-base64 segment | `invalid_token` | "malformed" |
  | header `alg: none` | `invalid_token` | "unsupported alg" |
  | header `alg: HS256` | `invalid_token` | "unsupported alg" |
  | header missing `kid` | `invalid_token` | "unknown kid" |
  | unknown `kid` after refresh | `invalid_token` | "unknown kid" |
  | tampered signature | `invalid_token` | "invalid signature" |
  | wrong-key signature | `invalid_token` | "invalid signature" |
  | expired `exp` | `invalid_token` | "token expired" |
  | future `nbf` | `invalid_token` | "token not yet valid" |
  | wrong `iss` | `invalid_token` | "invalid issuer" |
  | wrong `aud` | `invalid_token` | "invalid audience" |

  Single test, single assertion shape. Adding a row to §7 forces a row here.

- **A4** `aud` flexibility — both directions: token `aud` is array containing
  the configured string → valid; configured `audience` is array, token `aud`
  is one of its elements → valid.

### Group B — Pipeline ordering (security invariant)

- **B1** A token with `alg: none`, an expired `exp`, and a tampered signature
  produces `"unsupported alg"`. The earliest pipeline failure (§6) wins;
  signature and claims checks must never run on a malformed-header token.
  This is observable: if the order regresses, the error message changes and
  the security posture changes with it.

### Group C — Skew boundaries

- **C1** `exp` boundary: with `clockSkewSec = 60`, a token whose `exp` is
  `now − 60` is valid; a token whose `exp` is `now − 61` is expired.
- **C2** `nbf` boundary: symmetric. `nbf = now + 60` valid; `nbf = now + 61`
  not yet valid.
- **C3** Zero-skew baseline: `clockSkewSec = 0`, `exp` 1s past → expired.
  Pins default behavior so future skew changes are deliberate.

### Group D — JWKS cache lifecycle

- **D1** Cache hit: a kid known to the cache (from prior verify within TTL)
  verifies with **zero** fetcher calls.
- **D2** Cache miss → exactly one refresh; kid found in refreshed JWKS;
  verify proceeds.
- **D3** Concurrent kid-miss: two simultaneous requests for an unknown kid
  trigger **one** fetch; both requests succeed against the refreshed JWKS.
  (DoS invariant per §4.)
- **D4** Refresh rejects → in-flight promise cleared; the next request
  triggers a fresh refresh and succeeds. (Cleanup-on-reject invariant per §4.)
- **D5** Replace-on-refresh: cache contains kid A; JWKS now returns only kid
  B; a request with kid B triggers refresh; a subsequent request with kid A
  finds it evicted, triggers another refresh, kid A still absent → 401
  "unknown kid". (§3 eviction semantics.)
- **D6** Two `jwtAuth` instances pointing at the same `jwksUri` have isolated
  caches; a kid-miss against one does not populate the other; fetcher is
  called once per instance.
- **D7** TTL expiry: advance `now()` past `cacheTtlMs` → next request
  refetches even though the kid is "in" the cache.
- **D8** JWKS upstream failure: 5xx, network error, and malformed JWKS body
  each → 401 `invalid_token` "unknown kid"; `logger` called with `{ url,
  status }` (or `{ url, error }` for non-HTTP failures); upstream signal
  does not leak to the bearer.
- **D9** JWKS key filtering, parameterized: `kty: "EC"` filtered; `use:
  "enc"` filtered; `use` absent permitted; `kty: "RSA"` + `use: "sig"`
  permitted. Filtered keys are unresolvable; permitted keys verify normally.

### Group E — Scope normalization

- **E1** Parameterized over the §3 normalization table:

  | `claims.scope` input | `req.auth.scope` |
  |---|---|
  | `"read write"` | `["read", "write"]` |
  | `"   read   write  "` | `["read", "write"]` |
  | `"   "` | `[]` |
  | `["read", "write"]` | `["read", "write"]` |
  | `["read", "", 42, null, "write"]` | `["read", "write"]` |
  | missing | `[]` |
  | `null` | `[]` |
  | `42` | `[]` |
  | `{ foo: "bar" }` | `[]` |

  Asserts: `req.auth.scope` is the normalized array; `req.auth.claims.scope`
  is the input verbatim (when present); `next()` is called in every row
  (normalization never fails verification).

### Group F — `requireScope`

- **F1** `req.auth.scope` includes the required scope → `next()` called.
- **F2** `req.auth.scope` missing the required scope → 403; envelope
  `error="insufficient_scope" error_description="requires <scope>"`.

### Group G — Wiring errors (programmer mistakes)

- **G1** `requireScope` runs against a request where `req.auth` is undefined
  → throws synchronously inside the handler. (Per §12.)
- **G2** `jwtAuth` runs against a request where `req.auth` is already set
  → throws. (Catches double-mounting per §12.)

### Group H — Options validation

- **H1** Parameterized table of bad options → `jwtAuth(opts)` throws
  synchronously at the factory call site:

  | Bad option |
  |---|
  | `jwksUri` missing |
  | `jwksUri` not a parseable URL |
  | `audience` empty string |
  | `audience` empty array |
  | `issuer` missing |
  | `cacheTtlMs <= 0` |
  | `clockSkewSec < 0` |

### Group I — Zero-downtime key rotation (end-to-end)

- **I1** Walks the full §13 planned-rotation flow as a single narrative test:
  1. JWKS publishes kid A. A token signed with kid A → 200. (Cache
     populated; fetcher called once.)
  2. JWKS now publishes kid A and kid B. A token signed with kid B → 200,
     and the fetcher is called exactly **one** more time. (kid-miss → one
     refresh → both kids cached.)
  3. A second token with kid A → 200 with **no** additional fetch.
     (Both keys live in the same cache.)
  4. JWKS now publishes only kid B. Advance `now()` past `cacheTtlMs`.
     A token with kid A → 401 "unknown kid"; refresh ran but kid A is gone.
     A token with kid B → 200.

  Asserts the §13 promise as a single observable sequence, not as the
  conjunction of unit-level cache properties.

## Out of Scope

- Multi-algorithm verifier (HS256, ES256, etc.) — security decision (§1).
- Multi-issuer verification — mount multiple `jwtAuth` instances if needed.
- Multi-scope semantics in `requireScope` (any-of / all-of / claim-based authz).
- Token transport via query string (`?access_token=`) or form-encoded body.
- IDP-specific claim parsing — consumers narrow `req.auth.claims` themselves.
- Refresh tokens, OAuth flows, token introspection, dynamic client registration.
