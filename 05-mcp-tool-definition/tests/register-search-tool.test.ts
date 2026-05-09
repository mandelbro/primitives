import { describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerSearchTool, UpstreamError } from '../src/index.js';
import type { SearchToolArgs } from '../src/index.js';
import type { VectorDbClient, VectorMatch } from '../src/types.js';

const makeFakeClient = (): VectorDbClient => ({
  search: vi.fn(async () => ({ matches: [] })),
});

const makeFakeServer = () => {
  const registerTool = vi.fn();
  return {
    server: { registerTool } as unknown as McpServer,
    registerTool,
  };
};

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: ZodTypeAny;
};

// Local alias for the registered callback's signature.
// Args shape comes from our module (the project-defined schema),
// return shape comes from the SDK (the protocol's response envelope).
type SearchCallback = (args: SearchToolArgs) => Promise<CallToolResult>;

// CallToolResult.content is a discriminated union (text / image / audio / resource).
// Narrow on `type === 'text'` and surface the text payload, or fail the test.
const getResponseText = (result: CallToolResult): string => {
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(
      `expected first content block to be type:'text', got ${first?.type ?? 'undefined'}`,
    );
  }
  return first.text;
};

const VALID_ARGS = { query: 'q', index: 'i', topK: 5 } as const;

const registerAndGetConfig = (): ToolConfig => {
  const { server, registerTool } = makeFakeServer();
  registerSearchTool(server, { client: makeFakeClient() });
  return (registerTool.mock.calls[0]?.[1] ?? {}) as ToolConfig;
};

const setupCallback = (matches: VectorMatch[] = []) => {
  const search = vi.fn(async () => ({ matches }));
  const client = { search } as VectorDbClient;
  const { server, registerTool } = makeFakeServer();
  registerSearchTool(server, { client });
  const callback = registerTool.mock.calls[0]?.[2] as SearchCallback;
  return { callback, search };
};

const setupCallbackThatThrows = (error: unknown) => {
  const search = vi.fn(async () => {
    throw error;
  });
  const client = { search } as VectorDbClient;
  const { server, registerTool } = makeFakeServer();
  registerSearchTool(server, { client });
  const callback = registerTool.mock.calls[0]?.[2] as SearchCallback;
  return { callback, search };
};

// Wrapper-mediated error envelope shape (operational errors only).
type ErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
};

// Asserts isError:true and surfaces the parsed `error` body, or fails the test.
const getErrorBody = (result: CallToolResult): ErrorBody => {
  if (result.isError !== true) {
    throw new Error(
      `expected isError:true; got ${String(result.isError)}`,
    );
  }
  const parsed = JSON.parse(getResponseText(result));
  return parsed.error;
};

describe('registerSearchTool', () => {
  it('registers a tool named "vector_db_search_index" against the supplied server', () => {
    const { server, registerTool } = makeFakeServer();
    const client = makeFakeClient();

    registerSearchTool(server, { client });

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool.mock.calls[0]?.[0]).toBe('vector_db_search_index');
  });

  describe('description contract', () => {
    it('is present and a string', () => {
      expect(typeof registerAndGetConfig().description).toBe('string');
    });

    it('is between 200 and 1500 characters', () => {
      const description = registerAndGetConfig().description ?? '';
      expect(description.length).toBeGreaterThanOrEqual(200);
      expect(description.length).toBeLessThanOrEqual(1500);
    });

    it('contains the word "when" (when-to-use guidance)', () => {
      const description = registerAndGetConfig().description ?? '';
      expect(description.toLowerCase()).toMatch(/\bwhen\b/);
    });

    it('names the `namespace` concept', () => {
      const description = registerAndGetConfig().description ?? '';
      expect(description).toMatch(/namespace/i);
    });
  });

  describe('input schema', () => {
    // Test #3: required-field contract
    it.each(['query', 'index'] as const)(
      'rejects input missing the required `%s` field',
      (field) => {
        const schema = registerAndGetConfig().inputSchema;
        expect(schema).toBeDefined();
        const input: Record<string, unknown> = { ...VALID_ARGS };
        delete input[field];
        expect(schema?.safeParse(input).success).toBe(false);
      },
    );

    // Test #4: strict() contract — unknown top-level keys are rejected
    it('rejects unknown top-level keys (.strict() in effect)', () => {
      const schema = registerAndGetConfig().inputSchema;
      const result = schema?.safeParse({ ...VALID_ARGS, foo: 'bar' });
      expect(result?.success).toBe(false);
    });

    // Test #5: rejects topK values out of bounds
    it.each([0, 101])('rejects topK %s', (topK) => {
      const schema = registerAndGetConfig().inputSchema;
      expect(schema?.safeParse({ ...VALID_ARGS, topK }).success).toBe(false);
    });

    // Test #13: validation issue format for out-of-bounds topK
    it('produces a Zod issue at path["topK"] referencing the bound for topK = 500', () => {
      const schema = registerAndGetConfig().inputSchema;
      const result = schema?.safeParse({ ...VALID_ARGS, topK: 500 });
      expect(result?.success).toBe(false);
      if (result && !result.success) {
        const firstIssue = result.error.issues[0];
        expect(firstIssue?.path[0]).toBe('topK');
        expect(firstIssue?.message).toMatch(/100/);
      }
    });
  });

  describe('callback success path', () => {
    // Test #6 (partial): client invocation
    it('invokes client.search exactly once when the callback runs with valid args', async () => {
      const { callback, search } = setupCallback();

      await callback({ ...VALID_ARGS });

      expect(search).toHaveBeenCalledOnce();
    });

    // Test #8: positional argument forwarding (with optional filter + namespace)
    it('forwards index, query, topK, filter, and namespace to client.search positionally', async () => {
      const { callback, search } = setupCallback();

      await callback({
        query: 'q1',
        index: 'idx1',
        topK: 7,
        filter: { tag: 'foo' },
        namespace: 'ns1',
      });

      expect(search).toHaveBeenCalledWith('idx1', 'q1', 7, { tag: 'foo' }, 'ns1');
    });

    // Test #6 (partial): success envelope shape
    it('returns the success envelope: isError:false, content[0].type === "text", text parses as JSON with a matches array', async () => {
      const { callback } = setupCallback([
        { id: 'a', score: 0.5, metadata: {} },
      ]);

      const result = await callback({ ...VALID_ARGS });

      expect(result.isError).toBe(false);
      expect(result.content[0]?.type).toBe('text');
      const body = JSON.parse(getResponseText(result));
      expect(Array.isArray(body.matches)).toBe(true);
    });

    // Test #7: empty-result hint
    it('returns matches:[] with the empty-result hint and isError:false when client returns no matches', async () => {
      const { callback } = setupCallback([]);

      const result = await callback({ ...VALID_ARGS });

      expect(result.isError).toBe(false);
      const body = JSON.parse(getResponseText(result));
      expect(body).toEqual({
        matches: [],
        hint: 'no matches; try broadening filter or increasing topK',
      });
    });
  });

  describe('callback success path — data shape', () => {
    // Test #15: score rounding to four decimal places, with trailing zeros preserved.
    // Asserts on the raw text (not parsed JSON) because JSON.parse erases trailing zeros.
    it.each([
      [0.123456, '"score":0.1235', 'rounds down at the 5th decimal'],
      [0.99995, '"score":1.0000', 'rounds up via carry'],
      [1, '"score":1.0000', 'preserves trailing zeros for integer scores'],
    ])('renders score %f as %s (%s)', async (score, expectedFragment) => {
      const { callback } = setupCallback([{ id: 'a', score, metadata: {} }]);

      const result = await callback({ ...VALID_ARGS });

      expect(getResponseText(result)).toContain(expectedFragment);
    });

    // Test #14: metadata round-trip — nested objects, arrays, and null values preserved.
    it('round-trips metadata: nested objects, arrays, and null values are preserved', async () => {
      const metadata = {
        nested: { key: 'value', deep: { x: 1 } },
        arr: [1, 2, 3, 'string', null],
        nullField: null,
      };
      const { callback } = setupCallback([{ id: 'a', score: 0.5, metadata }]);

      const result = await callback({ ...VALID_ARGS });

      const body = JSON.parse(getResponseText(result));
      expect(body.matches[0].metadata).toEqual(metadata);
    });
  });

  describe('callback error path', () => {
    // Test #10: 5xx → UPSTREAM_UNAVAILABLE (representative statuses 503 and 504)
    it.each([503, 504])(
      'translates UpstreamError(%i) to UPSTREAM_UNAVAILABLE/retryable:true; raw message redacted',
      async (status) => {
        const rawMessage = 'database is on fire';
        const { callback } = setupCallbackThatThrows(
          new UpstreamError(status, rawMessage),
        );

        const result = await callback({ ...VALID_ARGS });

        const error = getErrorBody(result);
        expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(error.retryable).toBe(true);
        expect(error.message).not.toContain(rawMessage);
      },
    );

    // Test #11: 429 → RATE_LIMITED with retryAfterSeconds propagated
    it('translates UpstreamError(429, retryAfter:30) to RATE_LIMITED/retryable:true with retryAfterSeconds:30', async () => {
      const { callback } = setupCallbackThatThrows(
        new UpstreamError(429, 'too many requests', { retryAfter: 30 }),
      );

      const result = await callback({ ...VALID_ARGS });

      const error = getErrorBody(result);
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryable).toBe(true);
      expect(error.retryAfterSeconds).toBe(30);
    });

    // Test #12: 404 → NOT_FOUND
    it('translates UpstreamError(404) to NOT_FOUND/retryable:false', async () => {
      const { callback } = setupCallbackThatThrows(
        new UpstreamError(404, 'index not found'),
      );

      const result = await callback({ ...VALID_ARGS });

      const error = getErrorBody(result);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.retryable).toBe(false);
    });

    // Test #17: unmatched UpstreamError status (Concern A → INTERNAL)
    it('translates UpstreamError(400) (unmatched status) to INTERNAL/retryable:false; raw message redacted', async () => {
      const rawMessage = 'bad request body';
      const { callback } = setupCallbackThatThrows(
        new UpstreamError(400, rawMessage),
      );

      const result = await callback({ ...VALID_ARGS });

      const error = getErrorBody(result);
      expect(error.code).toBe('INTERNAL');
      expect(error.retryable).toBe(false);
      expect(error.message).not.toContain(rawMessage);
    });

    // Test #16: non-UpstreamError → INTERNAL
    it('translates non-UpstreamError TypeError to INTERNAL/retryable:false; raw message redacted', async () => {
      const rawMessage = 'cannot read property foo of undefined';
      const { callback } = setupCallbackThatThrows(new TypeError(rawMessage));

      const result = await callback({ ...VALID_ARGS });

      const error = getErrorBody(result);
      expect(error.code).toBe('INTERNAL');
      expect(error.retryable).toBe(false);
      expect(error.message).not.toContain(rawMessage);
    });
  });
});
