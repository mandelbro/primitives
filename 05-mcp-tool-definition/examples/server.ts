// Smoke wire-up: registers the tool against a real McpServer to confirm the
// SDK accepts our registration shape end-to-end. Run with:
//
//   pnpm example
//
// The unit tests in tests/ use a fake McpServer; this file proves the public
// API works against the real one.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchTool, UpstreamError } from '../src/index.js';
import type { VectorDbClient } from '../src/index.js';

// A fake VectorDbClient. A real implementation would call out to a vector DB
// (e.g., Pinecone) and embed the query server-side.
const fakeClient: VectorDbClient = {
  async search(index, _query, topK, _filter, _namespace) {
    if (index === 'unknown-index') {
      throw new UpstreamError(404, 'index not found');
    }
    if (index === 'overloaded') {
      throw new UpstreamError(429, 'too many requests', { retryAfter: 30 });
    }
    return {
      matches: [
        { id: 'doc-1', score: 0.9512, metadata: { title: 'first match' } },
        { id: 'doc-2', score: 0.7234, metadata: { title: 'second match' } },
      ].slice(0, topK),
    };
  },
};

const server = new McpServer({ name: 'vector-db-demo', version: '0.1.0' });

registerSearchTool(server, { client: fakeClient });

console.log('✓ registered vector_db_search_index against McpServer');
console.log('  ready to bind to a transport (e.g., StdioServerTransport)');
