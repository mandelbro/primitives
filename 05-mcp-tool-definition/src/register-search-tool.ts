import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UpstreamError } from './types.js';
import type { Opts, VectorMatch } from './types.js';

const TOOL_NAME = 'vector_db_search_index';
const EMPTY_RESULT_HINT = 'no matches; try broadening filter or increasing topK';

const TOOL_DESCRIPTION = [
  'Search a vector database index by natural-language query.',
  'Use this tool when the user asks a question that benefits from semantic recall over a known corpus —',
  'for example, finding documents, passages, or records by meaning rather than exact keyword match.',
  'Provide the index name and a `query` string in plain natural language;',
  'the underlying client embeds the query server-side, so callers never deal with vectors directly.',
  'Use `topK` (1–100) to bound how many matches are returned.',
  'The optional `namespace` argument routes the search to a specific tenant or partition within the index, enabling multi-tenant isolation.',
  'Pass `filter` as a metadata-shaped object to constrain matches by attributes the index has indexed.',
  'Returns a list of `{ id, score, metadata }` matches; an empty result is a successful response, not an error.',
].join(' ');

const inputShape = {
  query: z.string(),
  index: z.string(),
  topK: z.number().min(1).max(100),
  filter: z.record(z.unknown()).optional(),
  namespace: z.string().optional(),
};

const inputSchema = z.object(inputShape).strict();

// Args shape passed to the registered callback after SDK validation.
// Derived from inputSchema so the type stays in lockstep with the schema.
export type SearchToolArgs = z.infer<typeof inputSchema>;

// Manually build the match JSON so the score retains trailing zeros
// (JSON.stringify(1) === "1", not "1.0000"). We round, format to 4dp,
// and inject the score string verbatim. Math.round's round-half-up
// tie-break is load-bearing: 0.99995 * 10000 lands on 9999.5 in IEEE-754,
// which rounds up to 10000 → "1.0000".
const formatMatch = (m: VectorMatch): string => {
  const score = (Math.round(m.score * 10000) / 10000).toFixed(4);
  return `{"id":${JSON.stringify(m.id)},"score":${score},"metadata":${JSON.stringify(m.metadata)}}`;
};

// Build the success-envelope `text` payload from a list of matches.
//
// The body has two shapes by spec contract:
//   - Empty result  → { matches: [], hint: <coaching string> }
//                     Tells the agent "valid query, no matches" so it can act
//                     on the hint (broaden filter, raise topK) instead of
//                     retrying blindly. Empty results are SUCCESS, not error.
//   - Non-empty     → { matches: [<formatted match>, ...] }
//                     Canonical success body.
//
// We construct the JSON text manually rather than calling JSON.stringify on a
// payload object because each match's score must retain trailing 4-decimal
// formatting (see formatMatch above for the IEEE-754 reasoning). JSON.stringify
// on the EMPTY_RESULT_HINT string is still safe — it correctly escapes any
// future special characters in the hint.
const formatSuccessBody = (matches: VectorMatch[]): string =>
  matches.length === 0
    ? `{"matches":[],"hint":${JSON.stringify(EMPTY_RESULT_HINT)}}`
    : `{"matches":[${matches.map(formatMatch).join(',')}]}`;

// Translate a thrown value into the wrapper-mediated error envelope text.
//
// Mapping by spec contract (Error States):
//   UpstreamError(404)              → NOT_FOUND            / retryable:false
//   UpstreamError(429)              → RATE_LIMITED         / retryable:true / +retryAfterSeconds
//   UpstreamError(status >= 500)    → UPSTREAM_UNAVAILABLE / retryable:true
//   UpstreamError(any other status) → INTERNAL             / retryable:false  ← unmatched falls through
//   anything else (TypeError, ...)  → INTERNAL             / retryable:false
//
// Raw upstream/thrown messages are NEVER surfaced — operational errors carry
// generic per-code messages so the agent can reason about retry posture
// without leaking implementation details.
const formatErrorBody = (err: unknown): string => {
  if (err instanceof UpstreamError) {
    if (err.status === 404) {
      return JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'resource not found',
          retryable: false,
        },
      });
    }
    if (err.status === 429) {
      const base = {
        code: 'RATE_LIMITED' as const,
        message: 'rate limited by upstream',
        retryable: true,
      };
      const body =
        err.retryAfter !== undefined
          ? { ...base, retryAfterSeconds: err.retryAfter }
          : base;
      return JSON.stringify({ error: body });
    }
    if (err.status >= 500) {
      return JSON.stringify({
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'upstream service unavailable',
          retryable: true,
        },
      });
    }
    // Unmatched UpstreamError status: falls through to INTERNAL below.
  }
  return JSON.stringify({
    error: { code: 'INTERNAL', message: 'internal error', retryable: false },
  });
};

export function registerSearchTool(server: McpServer, opts: Opts): void {
  server.registerTool(
    TOOL_NAME,
    { description: TOOL_DESCRIPTION, inputSchema },
    async ({ index, query, topK, filter, namespace }) => {
      try {
        const { matches } = await opts.client.search(
          index,
          query,
          topK,
          filter,
          namespace,
        );
        return {
          content: [{ type: 'text', text: formatSuccessBody(matches) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: formatErrorBody(err) }],
          isError: true,
        };
      }
    },
  );
}
