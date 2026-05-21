/**
 * qa-debug MCP server factory — transport-agnostic library.
 *
 * Consumed by:
 *  - `bin/stdio.ts` — the S3 stdio CLI used by the MCP Inspector and the
 *    `evals/` engagement harness (paired with `InMemoryPauseStore`).
 *  - `extension/src/qa-debug-server.ts` — the S4 in-extension Streamable HTTP
 *    host (paired with `MementoPauseStore` over `ExtensionContext.globalState`).
 *
 * The factory takes an options object (per S4_DESIGN.md §5.3 — was positional
 * `createQaDebugServer(store)` in S3; S4 BREAKS that signature to
 * `createQaDebugServer({ pauseStore })`).
 *
 * Self-identifies as MCP server name `qa-debug` per ARCHITECTURE §3.2 — the
 * agent-facing FQN is `qa-debug:qa_*` per Skills best-practices.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PauseStore } from '@qa-debug/pause-store-types';
import { toFailureContextView } from '@qa-debug/pause-store-types';

import { errorResult } from './errors.js';
import {
  qa_get_failure_context,
  qa_propose_abort_suite,
  qa_propose_close_browser,
  qa_propose_mark_passed,
  qa_request_give_up,
  qa_request_retry,
} from './tools.js';

export interface CreateQaDebugServerOptions {
  pauseStore: PauseStore;
}

export function createQaDebugServer(options: CreateQaDebugServerOptions): McpServer {
  const { pauseStore: store } = options;
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
