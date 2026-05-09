# Primitives

A showcase of small, self-contained TypeScript and Python primitives — each one a focused exercise in spec-first design, TDD discipline, and the kind of decisions that only show up when you write the tests before the code.

Every primitive is independent: its own `package.json`, its own lockfile, its own `node_modules`. There is no monorepo tooling. Pick one, `cd` in, and read the spec.

## Primitives

| # | Primitive | Summary |
|---|---|---|
| 01 | [Rate Limiter](01-rate-limiter/) | In-memory token-bucket rate limiter. Discriminated-union returns, lazy refill, clock injection, no runtime deps. |
| 03 | Idempotency Middleware | _(placeholder — not yet started)_ |
| 04 | [API Client Retry & Backoff](04-api-client-retry-backoff/) | `fetchWithRetry`: retries with exponential backoff, `Retry-After` honoring, `AbortSignal` end-to-end, no runtime deps. |
| 05 | [MCP Tool Definition](05-mcp-tool-definition/) | `registerSearchTool`: wraps a Vector DB search endpoint as an MCP tool an LLM agent can call. |

## What's in each primitive

```
<primitive>/
  <name>-spec.md     ← Public API, Design Decisions, Error States, Test Plan
  README.md          ← design highlights + TDD progression cycles
  src/               ← implementation (small by design — ~90–125 lines)
  tests/             ← vitest cases mapped to numbered spec tests
```

**Read the spec first.** The implementation follows it; the tests pin it. Each primitive's README walks through the actual TDD cycles — what each red-green pass forced into existence and why.

## Running a primitive

Inside any primitive directory:

```bash
pnpm install
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
```

Node is pinned via `.tool-versions` (use `mise` or `asdf` if you have them).

## Why these exist

Each primitive isolates a problem that's easy to get half-right and surprisingly hard to get fully right — the kind that lives in production SDKs and middleware layers. The goal isn't reusable libraries; it's worked examples of:

- Letting a public API be shaped by tests written against it
- Writing the design decisions down in the spec where future-you can find them
- Refactoring only when duplication earns it (Rule of Three)
- Treating clock, sleep, and fetch as injected dependencies — not things to mock

Browse the `*-spec.md` and per-primitive `README.md` files for the interesting parts.

## License

[MIT](LICENSE)
