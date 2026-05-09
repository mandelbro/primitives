# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

A "primitive showcase" — each top-level numbered directory is an **independent, self-contained** TypeScript exercise built spec-first with TDD. There is no monorepo tooling (no workspaces, no shared `package.json`). Each primitive has its own `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, and `node_modules`.

Always `cd` into the specific primitive directory before running commands.

| Directory | What it is |
|---|---|
| `01-rate-limiter/` | In-memory token-bucket rate limiter (no runtime deps) |
| `03-idempotency-middleware/` | Empty placeholder — primitive not yet started |
| `04-api-client-retry-backoff/` | `fetchWithRetry` wrapper: retries, exponential backoff, `Retry-After`, `AbortSignal` (no runtime deps) |
| `05-mcp-tool-definition/` | `registerSearchTool` — wraps a Vector DB search endpoint as an MCP tool. Uses `@modelcontextprotocol/sdk` + `zod` |

## Common commands (run inside a primitive directory)

```bash
pnpm install
pnpm test          # vitest run
pnpm test:watch    # vitest watch
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test (use this as the default "is it green?" gate)

# Single test by name pattern (vitest)
pnpm exec vitest run -t "partial test name"
# Single test file
pnpm exec vitest run tests/<file>.test.ts
```

`05-mcp-tool-definition` additionally exposes `pnpm example` to smoke-wire the tool against a real `McpServer`.

Node version is pinned per-project via `.tool-versions` (currently `nodejs 25.6.1`). Use `mise` / `asdf` if available; otherwise ensure your local Node matches.

## TypeScript config — assume strict everywhere

All primitives use the same strict baseline: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`, `isolatedModules`, ESM (`"type": "module"`, `module: "ESNext"`, `moduleResolution: "Bundler"`). Imports of local files use the `.js` extension even though sources are `.ts` (bundler-style ESM).

## Spec-first TDD workflow (the load-bearing convention)

Every primitive follows the same structure:

```
<primitive>/
  <name>-spec.md                 ← read this FIRST (Public API, Design Decisions, Test Plan)
  README.md                      ← design highlights + TDD progression cycles
  src/                           ← implementation (kept small; ~90–125 lines target)
  tests/<name>.test.ts           ← vitest cases mapped to numbered spec tests
```

The spec is the source of truth. Tests pin the spec. Implementation follows the tests. When changing behavior:

1. Update the spec (or write a new spec entry) — `Public API`, `Design Decisions`, or `Test Plan`.
2. Add or modify a failing test that maps to a numbered spec test ID.
3. Make it pass with the smallest change.
4. Refactor only when duplication crosses Rule-of-Three.

Each primitive's README documents the actual TDD cycle history — when adding new work, append a new cycle row in the same style.

## Per-primitive design invariants worth knowing before editing

These are non-obvious decisions that exist for a reason. Don't undo them without updating the spec.

**`01-rate-limiter`**
- Discriminated-union return (`{ ok: true } | { ok: false, reason }`) — never throws on rate-limit denial. Throws only on programmer error (invalid cost / constructor args).
- Lazy refill on read (`consume`/`peek`); no timers, no background work.
- Float token storage, integer comparison at debit. `lastChecked` updates on every refill including denials (the "deny-storm" invariant).
- Clock is dependency injection, not test mocking. `performance.now()` by default — `Date.now()` is non-monotonic.

**`04-api-client-retry-backoff`**
- Curried API: `fetchWithRetry(opts) → (req) => Promise<res>`.
- Body type is `Uint8Array | string | undefined` (`BufferedBody`) — **not** a platform `Request`. Streams can't be replayed across retries; buffering happens at the SDK boundary above this primitive.
- `isIdempotent` gates **both** status-side retry (429/5xx) and network-error retry. Default denies POST.
- `Retry-After` consumes an attempt against `maxAttempts`. Parser is digits-XOR-letters: pure digits → delta-seconds; alphabetic → `Date.parse`; anything else falls through. The letter guard is load-bearing (V8's `Date.parse('5.5')` returns a finite number).
- `AbortError` propagates by reference — never wrapped, never caught for retry. The `if (isAbortError(err)) throw err;` line is regression-tested by referential equality.
- `AbortSignal` threads into both `fetch` and `sleep`.
- No jitter (deterministic backoff, easier to debug). Don't add it without a documented production case.

**`05-mcp-tool-definition`**
- Tool name: `vector_db_search_index`. Public function: `registerSearchTool(server, opts)`.
- The SDK boundary owns embedding — the tool wrapper never sees vectors.
- Upstream errors are signaled by throwing `UpstreamError(status, message)` from the injected `VectorDbClient`; the wrapper translates these into the agent-facing error envelope (e.g. 404 → `NOT_FOUND`).
- Input validation via `zod`.

## File organization rules (apply within each primitive)

- Source: `src/`. Tests: `tests/`. Spec: `<name>-spec.md` at the primitive root. Examples (when applicable): `examples/`.
- Don't create new files at the primitive root for source/tests/docs.
- Implementations are intentionally small; if a file approaches 400 lines, look for an extraction (`types.ts`, helper module) before growing further.

## When starting a new primitive

The empty `03-idempotency-middleware/` is the next slot. Bootstrap by mirroring the structure of `04-api-client-retry-backoff` (closest in shape: a wrapper around request handling).
