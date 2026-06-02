import * as vscode from 'vscode';

import { selectChromeCore } from '@qa-debug/pause-store-types';
import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_select_chrome';

interface Input {
  session_id: string;
  port: number;
}

/**
 * v5.16 — commits the chosen port from available_chromes.
 * selectChromeCore → pauseStore.recordChromeSelection validates the port,
 * persists selection, then fires onChromeSelected; session-manager's
 * subscriber registers playwright-mcp at the resolved http_root.
 * cdp_ws_url becomes non-null on the next qa_get_failure_context call.
 * Store logic shared with the stdio MCP host.
 */
export class SelectChromeTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, options.input);
    try {
      const { session_id, port } = options.input;
      const result = await selectChromeCore(this.deps.pauseStore, session_id, port, 'agent');
      return jsonResult(result);
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
