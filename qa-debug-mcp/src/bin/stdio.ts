/**
 * qa-debug-mcp stdio CLI — entrypoint for the published binary.
 *
 * Used by:
 *  - MCP Inspector smoke (`npx @modelcontextprotocol/inspector dist/qa-debug-mcp.js`).
 *  - The `evals/` engagement harness (`claude -p ... --mcp-config <stub.json>`).
 *
 * The extension does NOT use this binary — it imports `createQaDebugServer`
 * from `../server.js` and hosts the server in-process over Streamable HTTP
 * with a Memento-backed PauseStore. See `extension/src/qa-debug-server.ts`
 * and S4_DESIGN.md §5.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { InMemoryPauseStore } from '../pause-store.js';
import { createQaDebugServer } from '../server.js';

async function main(): Promise<void> {
  const pauseStore = new InMemoryPauseStore();
  const server = createQaDebugServer({ pauseStore });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('qa-debug MCP server running on stdio');
}

main().catch((err) => {
  console.error('qa-debug MCP server fatal error:', err);
  process.exit(1);
});
