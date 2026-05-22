/**
 * QaDebugMcpProvider — implements vscode.McpServerDefinitionProvider.
 *
 * CR-v5.14 §2.1 / §3.4 — narrowed to playwright-mcp only. The qa-debug verbs
 * migrated to the VS Code Language Model Tool API (extension/src/lm-tools/),
 * so they no longer need provider-side gating; visibility comes from the
 * `when: "qa-debug.paused"` clause on each `languageModelTools` contribution.
 *
 * Returns [] at idle, [playwright-mcp] during pause.
 * Fires onDidChangeMcpServerDefinitions on state transition.
 *
 * vscode.d.ts:20533 — provideMcpServerDefinitions(token: CancellationToken):
 *   ProviderResult<T[]>. Called eagerly; must not take actions requiring
 *   user interaction.
 * vscode.d.ts:20551 — resolveMcpServerDefinition(server, token): called when
 *   the editor starts the server. We pass through (no credential mutation).
 */

import * as vscode from 'vscode';

type State = 'idle' | { kind: 'paused'; cdpHttpEndpoint: string };

export class QaDebugMcpProvider implements vscode.McpServerDefinitionProvider {
  private state: State = 'idle';
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;

  setPaused(cdpHttpEndpoint: string): void {
    this.state = { kind: 'paused', cdpHttpEndpoint };
    this.emitter.fire();
  }

  setIdle(): void {
    this.state = 'idle';
    this.emitter.fire();
  }

  // Signature matches vscode.d.ts:20533 verbatim — CancellationToken required.
  provideMcpServerDefinitions(_token: vscode.CancellationToken): vscode.McpServerDefinition[] {
    if (this.state === 'idle') return [];
    return [
      new vscode.McpStdioServerDefinition(
        'playwright-mcp',
        'npx',
        ['-y', '@playwright/mcp@latest', '--cdp-endpoint', this.state.cdpHttpEndpoint],
      ),
    ];
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
