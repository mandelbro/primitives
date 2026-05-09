# MCP Tool Definition

## What is it?

An MCP tool definition function that wraps a Vector Database search endpoint as an MCP tool for agent consumption. The MCP server will register this tool and present it in the shape the Model Context Protocol specifies: a tool name, a tool description that the LLM reads to decide whether to call it, an input schema that bounds and validates arguments, and a response envelope shaped for an agent reader rather than a human one. This allows an agent to query a vector database by natural language without ever touching the wire-level API.

### From the prompt

> "We have a hypothetical Vector Database vector search endpoint. The wire shape is:
>
> `POST /indexes/{index}/query` with body `{ vector, topK, filter, namespace }`
> returning `{ matches: [{ id, score, metadata }, ...] }`.
>
> We need to register this as an MCP tool — using the `@modelcontextprotocol/sdk`
> TypeScript SDK — that an LLM agent can call. The public function is
> `registerSearchTool(server, opts)`.

# Public API

## Signature

```typescript
function registerSearchTool(server: McpServer, opts: Opts): void;
```

## Type Definitions

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type VectorDbClient = {
  search(
    index: string,
    query: string,
    topK: number,
    filter?: Record<string, unknown>,
    namespace?: string,
  ): Promise<{ matches: { id: string; score: number; metadata: object }[] }>;
};

type Opts = {
  client: VectorDbClient;
};

// Field-level Zod shape used to construct the strict object schema below.
const inputShape = {
  query: z.string(),
  index: z.string(),
  topK: z.number().min(1).max(100),
  filter: z.record(z.unknown()).optional(),
  namespace: z.string().optional(),
};

// Strict ZodObject passed to McpServer.registerTool. The SDK uses this for
// pre-callback validation: unknown top-level keys and out-of-bounds values
// are rejected at the SDK boundary (see Input Schema → Strictness).
const inputSchema = z.object(inputShape).strict();

// Client error contract. The wrapper translates these into the agent-facing
// error envelope (see Error States). Anything else thrown by the client is
// treated as an unhandled exception and surfaced as `INTERNAL`.
class UpstreamError extends Error {
  status: number;          // upstream HTTP status (404 / 429 / 5xx)
  retryAfter?: number;     // seconds, propagated from upstream header on 429 only
}
```

**Client error contract.** `VectorDbClient.search` signals HTTP-shaped upstream failures by throwing an `UpstreamError` carrying the upstream `status` and (on 429) the `retryAfter` seconds value. The wrapper inspects `status` to choose the agent-facing error code. Any other thrown value (`TypeError`, plain `Error`, etc.) is caught as an unhandled exception and translated to `INTERNAL`; the raw message is not surfaced.

## Convenience Exports

In addition to `registerSearchTool` and the types above, the package re-exports the following from `src/index.ts` for consumer use:

- `UpstreamError` (value) — clients import this to throw the error shape the wrapper recognizes.
- `VectorDbClient`, `VectorMatch`, `Opts`, `ErrorCode` (types) — for typed client implementations and consumer-side reasoning about error envelopes.
- `SearchToolArgs` (type) — `z.infer<typeof inputSchema>`. Useful if a consumer wants to accept or forward args using the same shape the registered callback receives.

## Design Decisions

### Tool Description

The tool description has two jobs: to tell the LLM when to use the tool, and to tell the LLM what shape of input it expects.

For "when to use it", the description should say something like "Use this tool when the user asks a question that benefits from semantic recall over a known corpus." For "what shape of input it expects", it should say "The input should be a natural-language query. The query is embedded server-side by the client."

**Description contract (asserted by tests):**

- Length between 200 and 1500 characters. The lower bound forces meaningful guidance; the upper bound caps token cost in the agent's tool list page, where every registered tool's description is loaded into context for routing.
- Contains the word "when" or equivalent when-to-use guidance.
- Names the `namespace` concept so the LLM understands multi-tenant routing.

### Input Schema

The input schema strictly binds the input to the expected shape. Unknown properties are rejected.

**Strictness enforcement.** `McpServer.registerTool` accepts a constructed `ZodObject` directly. We pass `z.object(inputShape).strict()` so the SDK's pre-callback validation rejects both unknown top-level keys and out-of-bounds values (e.g., `topK > 100`, missing `query`). When validation fails, the SDK throws `McpError` and wraps it into a `CallToolResult` with `isError: true` and a flat text message — this is the SDK-shaped envelope, **not** the structured `{ error: { code, message, retryable } }` envelope the wrapper uses for operational errors. By the time our callback runs, args have already been validated and shape-checked.

**Bounds.** `topK` is bounded `[1, 100]`. The tool accepts only natural-language `query` text; embedding is performed server-side by the client (no `vector` field in the tool surface).

**Filter shape.** `filter` is typed as `z.record(z.unknown()).optional()` — accept arbitrary object, pass through unchanged. Filter-shape validation belongs to the upstream client.

### Query string to vector embedding

The wire endpoint takes a vector; the tool takes a natural-language query and the client embeds it before calling the wire endpoint. Different inputs, different audiences, different shapes. Embedding is owned entirely by the `VectorDbClient` implementation; the wrapper does not see vectors.

### Deployment topology

Local development environment, no authentication. The tool is registered against an `McpServer` instance bound to `StdioServerTransport`.

### Pagination

`topK` is the only pagination knob.

### Token budget posture for the response

The response is trimmed to the most useful fields. The success envelope is `{ content: [{ type: 'text', text: <JSON-string> }], isError: false }` where the JSON body is either `{ matches: [{ id, score, metadata }, ...] }` or, on empty result, `{ matches: [], hint: "no matches; try broadening filter or increasing topK" }`. Scores are rounded to **four decimal places** (e.g., `0.123456` → `0.1235`).

### Response envelope

The response envelope is shaped for an agent reader rather than a human one. The success envelope is described above. The wrapper-mediated error envelope is `{ content: [{ type: 'text', text: <JSON-string> }], isError: true }` where the body is `{ error: { code, message, retryable, retryAfterSeconds? } }`. **This envelope only applies to operational errors the wrapper translates** (upstream and internal). Validation errors are SDK-mediated and use the SDK's flat text envelope (see Error States).

Empty results are a success, not an error. Return `{ matches: [], hint: "no matches; try broadening filter or increasing topK" }` and let the agent decide what to do.

### Error handling

Error codes are an **application-level** closed enum carried inside the structured envelope `text` for **operational errors only**: `NOT_FOUND`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`. (These are not the JSON-RPC `ErrorCode` values defined by MCP/JSON-RPC; they are this tool's contract for agent-facing retry/recovery reasoning.) See Error States for the trigger → code mapping. Input validation errors are surfaced by the SDK's own envelope and do not carry an application-level `code`.

### Tool naming

The tool is named `vector_db_search_index`. The `vector_db_*` prefix groups related tools (search, upsert, delete) into a single namespace in agent UIs that render tool lists. The suffix `search_index` is the verb_noun action within that namespace.

### SDK version

Targets `@modelcontextprotocol/sdk@^1.x` (verified against `1.13.1`). The `McpServer` class and its `registerTool(name, config, callback)` signature are stable within this major.

## Error States

**SDK-mediated errors (input validation).** The MCP SDK validates incoming `tools/call` arguments against the registered strict `inputSchema` *before* invoking the wrapper's callback. The wrapper does not see, shape, or modify these errors.

| Trigger | SDK envelope | Notes |
|---|---|---|
| Zod parse failure (unknown top-level key, out-of-bounds `topK`, missing required field, type mismatch) | `{ isError: true, content: [{ type: 'text', text: "Input validation error: ..." }] }` | `text` is Zod's default-formatted error message; typically names the offending field path and the violated constraint |

**Wrapper-mediated errors (operational).** The wrapper catches errors thrown from `client.search` and translates them into the structured envelope `{ content: [{ type: 'text', text: <JSON-string> }], isError: true }` where `text` parses to `{ error: { code, message, retryable, retryAfterSeconds? } }`.

| Trigger | Code | retryable | Notes |
|---|---|---|---|
| `UpstreamError` with `status === 404` | `NOT_FOUND` | `false` | |
| `UpstreamError` with `status === 429` | `RATE_LIMITED` | `true` | propagate `retryAfterSeconds` from `UpstreamError.retryAfter` |
| `UpstreamError` with `status >= 500` | `UPSTREAM_UNAVAILABLE` | `true` | raw upstream `message` is redacted from the translated envelope |
| `UpstreamError` with any other status (400, 401, 403, 410, etc.) | `INTERNAL` | `false` | unmatched status; fall through to the catch-all path; raw upstream `message` is redacted |
| Any other thrown value (`TypeError`, plain `Error`, etc.) | `INTERNAL` | `false` | log server-side; do not surface raw error or stack to the agent |

## Test Plan

1. Registers a tool named `vector_db_search_index` against the supplied server.
2. Tool description exists, is between 200 and 1500 characters, contains the word "when" or equivalent when-to-use guidance, and names the `namespace` concept.
3. Registered `inputSchema` rejects input missing `query` or `index` (the required-field contract): `inputSchema.safeParse({...})` returns `{ success: false }` when either field is omitted.
4. Registered `inputSchema` rejects unknown top-level keys (the `.strict()` contract): `inputSchema.safeParse({ query, index, topK, foo: "bar" })` returns `{ success: false }`.
5. Registered `inputSchema` enforces `topK` between 1 and 100: `safeParse` rejects `topK = 0` and `topK = 101`.
6. Invokes the client with the expected arguments and returns matches in the MCP content envelope; scores rounded to four decimal places; metadata preserved.
7. Empty client result returns `{ matches: [], hint: "no matches; try broadening filter or increasing topK" }` with `isError: false`.
8. Forwards `topK`, `filter` (non-empty), and `namespace` to the client unchanged.
9. *(dropped — folded into #4; SDK owns the validation envelope shape, not the wrapper.)*
10. Upstream 5xx is translated to code `UPSTREAM_UNAVAILABLE`, `retryable: true`, raw upstream message NOT present in the translated `message`.
11. Upstream 429 with `retryAfter` is translated to code `RATE_LIMITED`, `retryable: true`, `retryAfterSeconds` carried through.
12. Upstream 404 is translated to code `NOT_FOUND`, `retryable: false`.
13. Validation issue format: `inputSchema.safeParse({ query, index, topK: 500 })` returns a `ZodError` whose first issue has `path[0] === 'topK'` and a `message` referencing the upper bound `100`.
14. Metadata preservation: nested objects, arrays, and `null` values inside `metadata` round-trip unchanged.
15. Score rounding: a returned score of `0.123456` is rendered as `0.1235`; `0.99995` rounds to `1.0000`; trailing zeros are preserved in the JSON body.
16. Non-`UpstreamError` throw from the client (e.g., `TypeError`, plain `Error`) is translated to code `INTERNAL`, `retryable: false`; the raw error message is NOT present in the translated `message`.
17. `UpstreamError` with an unmatched status (e.g., `400`) is translated to code `INTERNAL`, `retryable: false`; the raw upstream message is NOT present in the translated `message`.

## Out of Scope

1. The underlying client is not tested.
2. Vector embedding is an upstream concern, owned by the client.
3. Live integration testing. Unit tests use a fake `VectorDbClient` that returns canned responses; no network calls and no real embeddings are performed in the test suite.
