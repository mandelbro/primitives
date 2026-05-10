# Spec Deviations & Open Decisions

Notes captured during the autonomous build for review at PR time. These are
points where implementation revealed something the spec didn't decide, or
where I made a judgment call that should be ratified or overruled.

## Open

(none yet)

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
