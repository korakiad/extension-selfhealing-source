/**
 * QaDebugMcpProvider — implements vscode.McpServerDefinitionProvider.
 *
 * CR-v5.14 §2.1 / §3.4 — the qa-debug verbs migrated to the VS Code Language
 * Model Tool API (extension/src/lm-tools/), so this provider exposes only the
 * external MCP servers the companion fronts during a pause. Today that is
 * playwright-mcp; the descriptor registry below is the extension point for a
 * second server (e.g. chrome-devtools-mcp, deferred to phase 2): push another
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

/**
 * One MCP server the provider may surface during a pause. `resolve` returns a
 * definition when the server should be live for the given paused state, or null
 * to withhold it.
 */
interface McpServerDescriptor {
  readonly id: string;
  resolve(state: PausedState): vscode.McpServerDefinition | null;
}

const PLAYWRIGHT_MCP: McpServerDescriptor = {
  id: 'playwright-mcp',
  resolve: (state) =>
    new vscode.McpStdioServerDefinition('playwright-mcp', 'npx', [
      '-y',
      '@playwright/mcp@latest',
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

  setPaused(cdpHttpEndpoint: string): void {
    this.state = { kind: 'paused', cdpHttpEndpoint };
    this.emitter.fire();
  }

  setIdle(): void {
    this.state = 'idle';
    this.emitter.fire();
  }

  /**
   * v5.16 PLAN-cdp-port-discovery §3.18 — clear MCP registration mid-pause
   * without ending the pause itself (used when `onChromeDeselected` fires
   * because qa_discover_chromes invalidated the prior selection). Re-selection
   * via `onChromeSelected` will re-register.
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
    return this.descriptors
      .map((d) => d.resolve(state))
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
