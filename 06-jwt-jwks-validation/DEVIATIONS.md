# Spec Deviations & Open Decisions

Notes captured during the autonomous build for review at PR time. These are
points where implementation revealed something the spec didn't decide, or
where I made a judgment call that should be ratified or overruled.

## Open

### `requireScope` realm is hardcoded to "api" (Batch 9) **REVIEW**

The spec's `requireScope(scope)` API takes only a scope string; there's no
way to pass a `realm`. The 403 envelope per RFC 6750 includes `realm=`,
which the implementation hardcodes to `"api"` — the same default jwtAuth
uses. If a consumer customizes `jwtAuth({ realm: "custom" })`, their 401
challenges will say `realm="custom"` but their 403s will still say
`realm="api"`.

Three options:
1. Leave as-is; document it. (Current.)
2. Extend `requireScope(scope, opts?)` with `{ realm }`.
3. Have `jwtAuth` stash its realm onto something like `app.locals` so
   `requireScope` can read it. Couples the two middlewares more tightly.

Worth a decision before merge.

### Skew boundary asymmetry — spec text revised in §6 (Batch 5) **REVIEW**

The original spec said both `exp` and `nbf` boundaries were inclusive of
validity. That is true for `nbf` but **not** for `exp` — jose v5's actual
checks are asymmetric:

- `exp <= now − tolerance` → expired (boundary exclusive of validity)
- `nbf > now + tolerance` → not yet valid (boundary inclusive of validity)

I updated the spec's "Skew boundary semantics" paragraph in §6 to describe
the actual behavior. Tests pin both boundaries against jose's real
behavior. **Worth a quick read to confirm the revised paragraph reflects
your intent.**

## Resolved during build

### Empty signature segment is structurally valid (Batch 3)

Spec §6 step 4 says "split on `.` into three segments" — the spec doesn't
explicitly say whether the signature segment may be empty. An `alg:none`
token has the shape `header.payload.` (3 segments, empty signature).

Decision: only header (segment 0) and payload (segment 1) must be non-empty;
signature may be empty. The unsigned-token case must pass the structure
check and fail at the alg check, otherwise B1 (alg=none + expired + tampered
→ "unsupported alg") cannot be observed.

Documented inline in `src/decode-header.ts`. No spec change needed — this is
the only consistent interpretation, but worth flagging.
