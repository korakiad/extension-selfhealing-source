/**
 * QaDebugMcpProvider — implements vscode.McpServerDefinitionProvider.
 *
 * The qa-debug verbs migrated to the VS Code Language Model Tool API
 * (extension/src/lm-tools/), so this provider exposes only the external MCP
 * servers the companion fronts during a pause. Today that is playwright-mcp;
 * the descriptor registry below is the extension point for a second server
 * (e.g. chrome-devtools-mcp, deferred to phase 2): push another
 * `McpServerDescriptor` and gate it via its own `resolve`.
 *
 * Returns [] at idle, [<servers whose resolve() returns non-null>] during pause.
 * Fires onDidChangeMcpServerDefinitions on state transition.
 *
 * vscode.d.ts:20533 — provideMcpServerDefinitions(token: CancellationToken):
 *   ProviderResult<T[]>. Called eagerly; must not take actions requiring
 *   user interaction.
 * vscode.d.ts:20551 — resolveMcpServerDefinition(server, token): called when
 *   the editor starts the server. We pass through (no credential mutation).
 */

import * as vscode from 'vscode';

/** State available to a descriptor when a chrome selection is committed. */
interface PausedState {
  cdpHttpEndpoint: string;
}

type State = 'idle' | ({ kind: 'paused' } & PausedState);

/** Instance context threaded into each descriptor's `resolve`. */
interface ResolveContext {
  /** Absolute path to the bundled `mcp-proxy.js` (see ./mcp-proxy.ts). */
  readonly proxyScriptPath: string;
}

/**
 * One MCP server the provider may surface during a pause. `resolve` returns a
 * definition when the server should be live for the given paused state, or null
 * to withhold it.
 */
interface McpServerDescriptor {
  readonly id: string;
  resolve(state: PausedState, ctx: ResolveContext): vscode.McpServerDefinition | null;
}

/**
 * The label VS Code registers our CDP-attached playwright-mcp under. MUST be
 * unique — NOT `playwright` / `playwright-mcp` — so it can never collide with a
 * QA's own playwright-mcp entry. VS Code keys two things off this label:
 *   1. Whole-server collision/disable (`mcpService.ts` `server.label.toLowerCase()`):
 *      on a clash the default `chat.mcp.collisionBehavior: disable` keeps only the
 *      higher-priority server, and a user `mcp.json` server (order 200) OUTRANKS an
 *      extension-contributed one (order 300) — so a clash would silently DISABLE
 *      our CDP server and leave the QA's non-CDP one. A unique label removes that.
 *   2. The ToolSet `referenceName` slug (label, lower-cased, spaces→`-`).
 * Kept identical to the value the mcp-proxy rewrites `serverInfo.name` to
 * (./mcp-proxy-rewrite.ts `REWRITTEN_SERVER_NAME`) so the server shows the SAME
 * name on every surface — the MCP-servers list (uses this label) and the
 * Configure-Tools / model tool-name prefix (uses serverInfo.name). The SKILL
 * steers the agent to this exact name; keep all three in sync.
 * See reference-vscode-mcp-collision-mechanics.
 */
export const QA_DEBUG_SERVER_LABEL = 'qa-debug-cdp';

const PLAYWRIGHT_MCP: McpServerDescriptor = {
  id: QA_DEBUG_SERVER_LABEL,
  // Spawn the mcp-proxy (which spawns the real `@playwright/mcp --cdp-endpoint`)
  // instead of playwright-mcp directly, so the proxy can rewrite the reported
  // `serverInfo.name` to a unique value and give the agent a distinct tool-name
  // prefix (`mcp_qa-debug-cdp_browser_*`). Fixes "Mode B". See ./mcp-proxy.ts.
  resolve: (state, ctx) =>
    new vscode.McpStdioServerDefinition(QA_DEBUG_SERVER_LABEL, 'node', [
      ctx.proxyScriptPath,
      '--cdp-endpoint',
      state.cdpHttpEndpoint,
    ]),
};

export class QaDebugMcpProvider implements vscode.McpServerDefinitionProvider {
  private state: State = 'idle';
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;

  // The set of servers the provider can surface. Single-entry today; add a
  // descriptor here to front another MCP server during pause.
  private readonly descriptors: readonly McpServerDescriptor[] = [PLAYWRIGHT_MCP];

  /** @param proxyScriptPath absolute path to the bundled `mcp-proxy.js`. */
  constructor(private readonly proxyScriptPath: string) {}

  setPaused(cdpHttpEndpoint: string): void {
    this.state = { kind: 'paused', cdpHttpEndpoint };
    this.emitter.fire();
  }

  setIdle(): void {
    this.state = 'idle';
    this.emitter.fire();
  }

  /**
   * v5.16 — clear MCP registration mid-pause without ending the pause itself
   * (used when `onChromeDeselected` fires because qa_discover_chromes
   * invalidated the prior selection). Re-selection via `onChromeSelected`
   * will re-register.
   */
  clearPaused(): void {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.emitter.fire();
  }

  // Signature matches vscode.d.ts:20533 verbatim — CancellationToken required.
  provideMcpServerDefinitions(_token: vscode.CancellationToken): vscode.McpServerDefinition[] {
    if (this.state === 'idle') return [];
    const state = this.state;
    const ctx: ResolveContext = { proxyScriptPath: this.proxyScriptPath };
    return this.descriptors
      .map((d) => d.resolve(state, ctx))
      .filter((def): def is vscode.McpServerDefinition => def !== null);
  }

  resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): vscode.McpServerDefinition {
    return server;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
