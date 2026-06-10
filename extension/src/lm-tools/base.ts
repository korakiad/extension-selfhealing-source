/**
 * Shared types + small helpers for the qa-debug LanguageModelTool classes.
 * Module-level deps (pauseStore, channel) are passed into the
 * registerQaDebugLmTools entry point and stamped on each tool instance via
 * constructor injection.
 *
 * Tool body semantics:
 *  - Audit log: every invoke emits `[qa-debug-lm] <name> called session=<id>`
 *    via auditLog() — replaces the v5.6 `[qa-debug-mcp]` wire+host log pair.
 *    Implementor: this is the single audit-line site; no lm.onDidInvokeTool
 *    event exists.
 *  - Errors: invoke throws Error('CODE: message') for QaToolError; VS Code
 *    surfaces .message to the LLM. The MCP-shaped errorResult helper in
 *    @qa-debug/tool-contracts/errors is NOT used here; it remains for the
 *    stdio MCP CLI (qa-debug-mcp/src/server.ts) that still wraps tool errors
 *    in MCP envelopes.
 */

import * as vscode from 'vscode';

import type { LiveTargetStore } from '../live-target-store.js';
import type { MementoPauseStore } from '../pause-store.js';
import { appendInfo } from '../output-channel.js';

export interface LmToolDeps {
  pauseStore: MementoPauseStore;
  /** Live Inspect Session target — read by the generalized picker +
   *  qa_start_live_session so they work outside a Mocha pause. */
  liveTargetStore: LiveTargetStore;
  auditChannel: vscode.OutputChannel;
}

export function auditLog(
  channel: vscode.OutputChannel,
  toolName: string,
  args: { session_id?: string } | undefined,
): void {
  const sessionId = args?.session_id ?? 'active';
  appendInfo(channel, `[qa-debug-lm] ${toolName} called session=${sessionId}`);
}

/** Converts QaToolError / other thrown errors into a tool-result text part so
 *  the model receives a structured CODE: message envelope. Mirrors the MCP
 *  errorResult helper but in vscode.LanguageModelToolResult shape. */
export function toErrorResult(err: unknown): vscode.LanguageModelToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  // QaToolError already prefixes with CODE: in its message via the way the
  // tool body composes the throw. If a non-QaToolError leaks, treat as INTERNAL.
  const hasCodePrefix = /^[A-Z_]+:\s/.test(msg);
  const text = hasCodePrefix ? msg : `INTERNAL_ERROR: ${msg}`;
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

export function jsonResult(payload: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
  ]);
}
