# MCP Tool Definition

Wraps a hypothetical Vector Database search endpoint as an MCP tool an LLM agent can call. The public function `registerSearchTool(server, opts)` registers a tool named `vector_db_search_index` against an `McpServer` from `@modelcontextprotocol/sdk`. Built with TypeScript, Zod for input validation, and Vitest for tests.

## Specification

See [mcp-tool-definition-spec.md](mcp-tool-definition-spec.md) — public API, design decisions, error states, and the test plan.

## Quick start

```bash
pnpm install
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm check         # typecheck + test
pnpm example       # smoke wire-up against a real McpServer
```

## Layout

| Path | What it is |
|---|---|
| `mcp-tool-definition-spec.md` | The spec — public API, design decisions, error states, atomic test plan |
| `src/register-search-tool.ts` | Implementation |
| `src/types.ts` | `VectorDbClient`, `VectorMatch`, `Opts`, `ErrorCode`, `UpstreamError` |
| `src/index.ts` | Public exports |
| `tests/register-search-tool.test.ts` | Tests mapping to the spec's Test Plan (25 atomic, 17 spec entries) |
| `examples/server.ts` | Smoke wire-up — registers the tool against a real `McpServer` |

Read the spec first. The implementation follows it; the tests pin it.

## Public API at a glance

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchTool, UpstreamError } from './src/index.js';
import type { VectorDbClient } from './src/index.js';

const client: VectorDbClient = {
  async search(index, query, topK, filter, namespace) {
    // SDK boundary owns embedding; the tool wrapper never sees vectors.
    // Signal upstream HTTP-shaped failures by throwing UpstreamError;
    // the wrapper translates these into the agent-facing error envelope.
    if (await indexMissing(index)) {
      throw new UpstreamError(404, 'index not found'); // → NOT_FOUND
    }
    return { matches: [/* { id, score, metadata }, ... */] };
  },
};

const server = new McpServer({ name: 'vector-db', version: '0.1.0' });
registerSearchTool(server, { client });
```

See `examples/server.ts` for a runnable demo (`pnpm example`).
