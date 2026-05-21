/**
 * qa-debug-mcp — stdio MCP server exposing 6 qa_* tools.
 * ARCHITECTURE §3.2. Self-identifies as server name 'qa-debug' (lowercase, hyphenated)
 * to match published Anthropic Skills FQN convention `qa-debug:qa_get_failure_context`.
 *
 * S3 ships an InMemoryPauseStore stub. S4 swaps via constructor DI when the VS Code
 * extension hosts this server in-process and feeds it a Memento-backed store.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { errorResult } from './errors.js';
import { InMemoryPauseStore, type PauseStore, toFailureContextView } from './pause-store.js';
import {
  qa_get_failure_context,
  qa_propose_abort_suite,
  qa_propose_close_browser,
  qa_propose_mark_passed,
  qa_request_give_up,
  qa_request_retry,
} from './tools.js';

export function createQaDebugServer(store: PauseStore): McpServer {
  const server = new McpServer({ name: 'qa-debug', version: '0.0.0' });

  server.registerTool(
    qa_get_failure_context.name,
    {
      description: qa_get_failure_context.description,
      inputSchema: qa_get_failure_context.inputSchemaZod,
    },
    async (args) => {
      try {
        const input = qa_get_failure_context.inputSchemaZod.parse(args);
        const active = store.getActivePause(input.session_id)!;
        const proposal = store.pollProposal(active.session_id);
        const view = toFailureContextView(active, proposal, input.response_format ?? 'concise');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(view, null, 2) }],
          structuredContent: view as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    qa_request_retry.name,
    {
      description: qa_request_retry.description,
      inputSchema: qa_request_retry.inputSchemaZod,
    },
    async (args) => {
      try {
        const input = qa_request_retry.inputSchemaZod.parse(args);
        const result = store.recordDecision(input.session_id, 'retry', input.reason);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    qa_request_give_up.name,
    {
      description: qa_request_give_up.description,
      inputSchema: qa_request_give_up.inputSchemaZod,
    },
    async (args) => {
      try {
        const input = qa_request_give_up.inputSchemaZod.parse(args);
        const result = store.recordDecision(input.session_id, 'give_up', input.reason);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const tool of [
    qa_propose_mark_passed,
    qa_propose_close_browser,
    qa_propose_abort_suite,
  ] as const) {
    const kind =
      tool === qa_propose_mark_passed
        ? 'mark_passed'
        : tool === qa_propose_close_browser
          ? 'close_browser'
          : 'abort_suite';
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchemaZod },
      async (args) => {
        try {
          const input = tool.inputSchemaZod.parse(args);
          const proposal = store.proposeAction(input.session_id, kind, input.rationale);
          const payload = { proposal_id: proposal.proposal_id, status: proposal.status };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
            structuredContent: payload,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  return server;
}

async function main() {
  const store = new InMemoryPauseStore();
  const server = createQaDebugServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('qa-debug MCP server running on stdio');
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('qa-debug-mcp.js') || process.argv[1].endsWith('qa-debug-mcp.ts'));

if (invokedDirectly) {
  main().catch((err) => {
    console.error('qa-debug MCP server fatal error:', err);
    process.exit(1);
  });
}
