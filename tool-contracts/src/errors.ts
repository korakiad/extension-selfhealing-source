export type QaErrorCode =
  | 'NO_ACTIVE_PAUSE'
  | 'SESSION_NOT_FOUND'
  // v5.16
  | 'INVALID_PORT'
  | 'NO_CHROMES_FOUND'
  | 'BROWSER_NOT_SELECTED'
  // qa_pick_element (CDP-native Overlay inspector)
  | 'CDP_CONNECT_FAILED'
  // identify-live: no pause AND no live inspect session is active. Raised by
  // the generalized picker + qa_start_live_session when neither inspection
  // surface exists for the request.
  | 'NO_ACTIVE_INSPECTION'
  // qa_testrail_* (PLAN-testrail.md). AUTH_FAILED..SERVER_ERROR map 1:1 to
  // TestRail's documented HTTP error table; the rest are client-side guards.
  | 'TESTRAIL_NOT_CONFIGURED'
  | 'WRONG_TOOL_FOR_WRITE'
  | 'WRONG_TOOL_FOR_READ'
  | 'UNKNOWN_ENDPOINT_VERB'
  | 'UNSUPPORTED_ENDPOINT'
  | 'INVALID_ENDPOINT'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'ENDPOINT_NOT_FOUND'
  | 'MAINTENANCE'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'PARSE_ERROR'
  | 'NETWORK_ERROR'
  | 'UNEXPECTED_BINARY'
  | 'ATTACHMENT_OUTSIDE_WORKSPACE'
  | 'NO_WORKSPACE';

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
