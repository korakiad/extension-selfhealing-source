/**
 * qa-debug MCP server factory — transport-agnostic library.
 *
 * Stdio/evals only. The extension no longer hosts qa-debug over MCP: as of
 * v5.14 the qa-debug verbs are VS Code Language Model Tools
 * (extension/src/lm-tools/), and the old in-extension `qa-debug-server.ts`
 * Streamable-HTTP host was deleted. This factory now backs only:
 *  - `bin/stdio.ts` — the stdio CLI used by the MCP Inspector and the
 *    `evals/` engagement harness (paired with `InMemoryPauseStore`).
 *
 * The factory takes an options object: `createQaDebugServer({ pauseStore })`.
 *
 * Self-identifies as MCP server name `qa-debug`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PauseStore } from '@qa-debug/pause-store-types';
import {
  discoverChromesCore,
  noChromesFoundMessage,
  selectChromeCore,
  toFailureContextView,
} from '@qa-debug/pause-store-types';

import { errorResult, QaToolError } from '@qa-debug/tool-contracts/errors';
import {
  qa_discover_chromes,
  qa_get_failure_context,
  qa_select_chrome,
} from '@qa-debug/tool-contracts/tools';

import { probePorts } from './probe-ports.js';

export interface CreateQaDebugServerOptions {
  pauseStore: PauseStore;
  /**
   * v5.4 — host-side hook fired alongside MCP `notifications/message` on
   * every tool invocation. The extension wires this to its Output Channel so
   * test #4 (Agent-mode auto-engagement smoke) is falsifiable via
   * Output-Channel grep, independent of whether the MCP client renders the
   * wire-side log. Optional so the stdio CLI (Inspector/evals) can ignore it.
   */
  onInvocation?: (toolName: string, sessionId: string) => void;
}

export function createQaDebugServer(options: CreateQaDebugServerOptions): McpServer {
  const { pauseStore: store } = options;
  // v5.4 — enable the MCP `logging` server capability so per-tool
  // invocation notifications reach the client (and, in S4, the extension's
  // Output Channel via the qa-debug-server Streamable HTTP host).
  // server/index.js:415 — sendLoggingMessage is a no-op unless this capability
  // is declared.
  const server = new McpServer(
    { name: 'qa-debug', version: '0.0.0' },
    { capabilities: { logging: {} } },
  );

  // v5.4 — per-tool invocation log. Makes test #4 (Agent-mode
  // auto-engagement smoke) falsifiable: a positive log line proves the
  // qa-debug tool fired without a preceding "Allow tool" confirmation dialog.
  // Fires the wire-side MCP notification (consumed by the MCP client) AND the
  // host-side onInvocation callback (consumed by the extension Output Channel
  // for F5-smoke verification).
  const logInvocation = (toolName: string, args: unknown): void => {
    const sessionId = (args as { session_id?: string })?.session_id ?? 'active';
    void server.sendLoggingMessage({
      level: 'info',
      data: `[qa-debug-mcp] ${toolName} called session=${sessionId}`,
    });
    options.onInvocation?.(toolName, sessionId);
  };

  server.registerTool(
    qa_get_failure_context.name,
    {
      description: qa_get_failure_context.description,
      inputSchema: qa_get_failure_context.inputSchemaZod,
      annotations: qa_get_failure_context.annotations,
    },
    async (args) => {
      logInvocation(qa_get_failure_context.name, args);
      try {
        const input = qa_get_failure_context.inputSchemaZod.parse(args);
        const active = store.getActivePause(input.session_id)!;
        const view = toFailureContextView(active, input.response_format ?? 'concise');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(view, null, 2) }],
          structuredContent: view as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- v5.16 — Mode C discovery + selection ----

  server.registerTool(
    qa_discover_chromes.name,
    {
      description: qa_discover_chromes.description,
      inputSchema: qa_discover_chromes.inputSchemaZod,
      annotations: qa_discover_chromes.annotations,
    },
    async (args) => {
      logInvocation(qa_discover_chromes.name, args);
      try {
        const input = qa_discover_chromes.inputSchemaZod.parse(args);
        // Shared core validates the session BEFORE the network probe (stale
        // session → NO_ACTIVE_PAUSE / SESSION_NOT_FOUND synchronously, not after
        // a 2.5s parallel timeout) and only replaces available_chromes when ≥1
        // responded.
        const { available_chromes, selection_cleared } = await discoverChromesCore(
          store,
          probePorts,
          input.session_id,
          input.ports,
        );
        if (available_chromes.length === 0) {
          throw new QaToolError('NO_CHROMES_FOUND', noChromesFoundMessage(input.ports));
        }
        const payload = { available_chromes, selection_cleared };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    qa_select_chrome.name,
    {
      description: qa_select_chrome.description,
      inputSchema: qa_select_chrome.inputSchemaZod,
      annotations: qa_select_chrome.annotations,
    },
    async (args) => {
      logInvocation(qa_select_chrome.name, args);
      try {
        const input = qa_select_chrome.inputSchemaZod.parse(args);
        const payload = await selectChromeCore(store, input.session_id, input.port, 'agent');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
