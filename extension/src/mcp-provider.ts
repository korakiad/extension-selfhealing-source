/**
 * QaDebugMcpProvider — implements vscode.McpServerDefinitionProvider.
 *
 * S4_DESIGN.md §4. Returns [] at idle, [playwright-mcp, qa-debug] during pause.
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

  constructor(
    private readonly qaDebugUri: vscode.Uri,
    private readonly qaDebugToken: string,
  ) {}

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
      new vscode.McpHttpServerDefinition(
        'qa-debug',
        this.qaDebugUri,
        { 'X-Qa-Debug-Token': this.qaDebugToken },
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
