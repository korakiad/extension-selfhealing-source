import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_select_chrome';

interface Input {
  session_id: string;
  port: number;
}

/**
 * v5.16 PLAN-cdp-port-discovery §3.12.5 — commits the chosen port from
 * available_chromes. pauseStore.recordChromeSelection validates the port,
 * persists selection, then fires onChromeSelected; session-manager's
 * subscriber then registers playwright-mcp at the resolved http_root
 * (§3.18). cdp_ws_url becomes non-null on the next qa_get_failure_context
 * call.
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
      const selection = await this.deps.pauseStore.recordChromeSelection(
        session_id,
        port,
        'agent',
      );
      return jsonResult({
        cdp_ws_url: selection.cdp_ws_url,
        port: selection.port,
        page_titles: selection.page_titles,
      });
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
