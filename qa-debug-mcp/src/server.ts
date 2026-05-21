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

import { errorResult, QaToolError } from './errors.js';
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
  /**
   * v5.4 §2.7 — host-side hook fired alongside MCP `notifications/message` on
   * every tool invocation. The extension wires this to its Output Channel so
   * CR §4.5 test #4 (Agent-mode auto-engagement smoke) is falsifiable via
   * Output-Channel grep, independent of whether the MCP client renders the
   * wire-side log. Optional so the stdio CLI (Inspector/evals) can ignore it.
   */
  onInvocation?: (toolName: string, sessionId: string) => void;
  /**
   * v5.6 — commits a request-verb decision (retry / give_up) through the
   * live DecisionRouter so the mocha child's pending `decision.await` IPC
   * resolves and the extension's pause-status-bar + Test Explorer hide.
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
    kind: 'retry' | 'give_up',
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
    qa_request_retry.name,
    {
      description: qa_request_retry.description,
      inputSchema: qa_request_retry.inputSchemaZod,
      annotations: qa_request_retry.annotations,
    },
    async (args) => {
      logInvocation(qa_request_retry.name, args);
      try {
        const input = qa_request_retry.inputSchemaZod.parse(args);
        // v5.6 — store-first ordering: validate session_id + clear proposal slot
        // before reaching for live runtime state. Inverted order would commit
        // through DecisionRouter then fail the agent with SESSION_NOT_FOUND
        // after the mocha child already respawned (strictly worse).
        const result = store.recordDecision(input.session_id, 'retry', input.reason);
        if (options.onDecision) {
          const committed = options.onDecision(input.session_id, 'retry', input.reason);
          if (!committed) {
            throw new QaToolError(
              'PAUSE_ALREADY_RESOLVED',
              'Pause already resolved by another caller; no respawn was triggered. ' +
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
        // v5.6 — same store-first ordering as qa_request_retry above.
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
      {
        description: tool.description,
        inputSchema: tool.inputSchemaZod,
        annotations: tool.annotations,
      },
      async (args) => {
        logInvocation(tool.name, args);
        try {
          const input = tool.inputSchemaZod.parse(args);
          // v5.2 §2.6 [R#3-Q1]: qa_propose_close_browser declines in Mode A
          // because the user's test code owns the browser lifecycle via
          // `browser.deleteSession()`. Decline-with-reason per Anthropic
          // "high signal information back to agents" guidance — lets the
          // agent update its plan instead of waiting on a no-op.
          if (kind === 'close_browser') {
            const active = store.getActivePause(input.session_id)!;
            if (active.mode === 'A') {
              const payload = {
                proposal_id: '',
                status: 'declined' as const,
                reason:
                  'browser is owned by your test code (Mode A); close it via ' +
                  'browser.deleteSession() in your test teardown. The QA Debug Companion ' +
                  'does not close a browser it does not own. See ARCHITECTURE-CR-v5.2 §2.6.',
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
                structuredContent: payload,
              };
            }
          }
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
