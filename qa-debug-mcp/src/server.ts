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

import { errorResult, QaToolError } from '@qa-debug/tool-contracts/errors';
import {
  qa_discover_chromes,
  qa_get_failure_context,
  qa_propose_abort_suite,
  qa_propose_mark_passed,
  qa_request_give_up,
  qa_select_chrome,
} from '@qa-debug/tool-contracts/tools';

import { probePorts } from './probe-ports.js';

export interface CreateQaDebugServerOptions {
  pauseStore: PauseStore;
  /**
   * v5.4 §2.7 — host-side hook fired alongside MCP `notifications/message` on
   * every tool invocation. The extension wires this to its Output Channel so
   * CR §4.5 test #4 (Agent-mode auto-engagement smoke) is falsifiable via
   * Output-Channel grep, independent of whether the MCP client renders the
   * wire-side log. Optional so the stdio CLI (Inspector/evals) can ignore it.
   */
  onInvocation?: (toolName: string, sessionId: string) => void;
  /**
   * Commits a request-verb decision (give_up) through the live DecisionRouter
   * so the mocha child's pending `decision.await` IPC resolves and the
   * extension's pause-status-bar + Test Explorer hide.
   *
   * Returns `true` when a pending callback was found and resolved; `false`
   * when the pause was already committed by another caller (UI-button race
   * or stale-resume cleanup beat the agent by milliseconds). The server
   * surfaces `false` to the caller as PAUSE_ALREADY_RESOLVED.
   *
   * Optional so the stdio CLI (Inspector / evals stub) can omit it; the
   * in-memory PauseStore + scripted scenarios in evals have no live mocha
   * decision.await IPC to drive.
   */
  onDecision?: (
    sessionId: string,
    kind: 'give_up',
    reason: string,
  ) => boolean;
}

export function createQaDebugServer(options: CreateQaDebugServerOptions): McpServer {
  const { pauseStore: store } = options;
  // v5.4 §2.7 — enable the MCP `logging` server capability so per-tool
  // invocation notifications reach the client (and, in S4, the extension's
  // Output Channel via the qa-debug-server Streamable HTTP host).
  // server/index.js:415 — sendLoggingMessage is a no-op unless this capability
  // is declared.
  const server = new McpServer(
    { name: 'qa-debug', version: '0.0.0' },
    { capabilities: { logging: {} } },
  );

  // v5.4 §2.7 — per-tool invocation log. Makes CR §4.5 test #4 (Agent-mode
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
    qa_request_give_up.name,
    {
      description: qa_request_give_up.description,
      inputSchema: qa_request_give_up.inputSchemaZod,
      annotations: qa_request_give_up.annotations,
    },
    async (args) => {
      logInvocation(qa_request_give_up.name, args);
      try {
        const input = qa_request_give_up.inputSchemaZod.parse(args);
        // v5.6 — store-first ordering: validate session_id + clear proposal
        // slot before reaching for live runtime state.
        const result = store.recordDecision(input.session_id, 'give_up', input.reason);
        if (options.onDecision) {
          const committed = options.onDecision(input.session_id, 'give_up', input.reason);
          if (!committed) {
            throw new QaToolError(
              'PAUSE_ALREADY_RESOLVED',
              'Pause already resolved by another caller; no give_up effect was triggered. ' +
                'Call qa_get_failure_context (omit session_id) to ground in current state, ' +
                'then re-classify if a new pause arrived. Do NOT re-issue against the stale session_id.',
            );
          }
        }
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
    qa_propose_abort_suite,
  ] as const) {
    const kind: 'mark_passed' | 'abort_suite' =
      tool === qa_propose_mark_passed ? 'mark_passed' : 'abort_suite';
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchemaZod,
        annotations: tool.annotations,
      },
      async (args) => {
        logInvocation(tool.name, args);
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

  // ---- v5.16 PLAN-cdp-port-discovery — Mode C discovery + selection ----

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
        // Validate session-id BEFORE the network probe so a stale session
        // surfaces synchronously as NO_ACTIVE_PAUSE / SESSION_NOT_FOUND
        // rather than after a 2.5s parallel timeout.
        store.getActivePause(input.session_id);
        const chromes = await probePorts(input.ports);
        if (chromes.length === 0) {
          throw new QaToolError(
            'NO_CHROMES_FOUND',
            `None of the supplied ports [${input.ports.join(', ')}] responded to /json/version. ` +
              'Re-ask the user, or surface the framework launch failure.',
          );
        }
        const { cleared } = await store.replaceAvailableChromes(input.session_id, chromes);
        const payload = { available_chromes: chromes, selection_cleared: cleared };
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
        const selection = await store.recordChromeSelection(input.session_id, input.port, 'agent');
        const payload = {
          cdp_ws_url: selection.cdp_ws_url,
          port: selection.port,
          page_titles: selection.page_titles,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
