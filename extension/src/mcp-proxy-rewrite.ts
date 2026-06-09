/**
 * Pure rewrite logic for the stdio MCP proxy (see ./mcp-proxy.ts), split out so
 * it can be unit-tested without the proxy's process/stdio side effects.
 *
 * VS Code derives the model-facing tool-name prefix from
 * `serverInfo.title || serverInfo.name` (workbench `McpPrefixGenerator`). By
 * forcing a short, unique `serverInfo.name` we make our tools appear as
 * `mcp_qa-debug-cdp_browser_*`, distinct from a QA's own playwright-mcp (which
 * reports `serverInfo.name: "Playwright"`). See reference-vscode-mcp-collision-mechanics.
 */

/**
 * Rewritten serverInfo.name → tool prefix `mcp_qa-debug-cdp_`. MUST stay short:
 * VS Code caps the prefix base at ~13 chars (`McpToolName.MaxPrefixLen` 18 minus
 * `mcp_` minus the trailing `_`); longer names are silently truncated. 12 chars.
 */
export const REWRITTEN_SERVER_NAME = 'qa-debug-cdp';

/** Rewrite one stdio line; returns the original text unless we changed it. */
export function rewriteLine(line: string): string {
  if (line.trim().length === 0) return line;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return line; // not JSON on this transport — pass through verbatim
  }
  const changed = Array.isArray(msg)
    ? msg.map(rewriteInitialize).some(Boolean)
    : rewriteInitialize(msg);
  return changed ? JSON.stringify(msg) : line;
}

/** Mutate `serverInfo.name` (and drop `title`) on an initialize response. */
export function rewriteInitialize(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const serverInfo = (msg as { result?: { serverInfo?: { name?: unknown; title?: unknown } } })
    .result?.serverInfo;
  if (serverInfo && typeof serverInfo.name === 'string') {
    serverInfo.name = REWRITTEN_SERVER_NAME;
    delete serverInfo.title; // VS Code prefers title over name for the prefix — drop it
    return true;
  }
  return false;
}
