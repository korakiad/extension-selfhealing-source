export type QaErrorCode =
  | 'NO_ACTIVE_PAUSE'
  | 'SESSION_NOT_FOUND'
  | 'PAUSE_ALREADY_RESOLVED'
  // v5.16 PLAN-cdp-port-discovery
  | 'INVALID_PORT'
  | 'NO_CHROMES_FOUND'
  | 'BROWSER_NOT_SELECTED';

export class QaToolError extends Error {
  constructor(public readonly code: QaErrorCode, message: string) {
    super(message);
    this.name = 'QaToolError';
  }
}

/**
 * MCP-shaped error envelope. Kept here (instead of in the MCP server) because
 * the stdio CLI in qa-debug-mcp/src/server.ts still wraps tool errors in this
 * shape for the evals harness. The extension's LM-tool path uses its own
 * vscode.LanguageModelToolResult wrapper and does not call this helper.
 */
export function errorResult(err: unknown) {
  if (err instanceof QaToolError) {
    return {
      content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `INTERNAL_ERROR: ${msg}` }],
    isError: true,
  };
}
