import * as vscode from 'vscode';

import { toFailureContextView } from '@qa-debug/pause-store-types';
import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_get_failure_context';

interface Input {
  session_id?: string;
  response_format?: 'concise' | 'detailed';
}

export class GetFailureContextTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, options.input);
    try {
      const input = options.input;
      const active = this.deps.pauseStore.getActivePause(input.session_id);
      if (!active) {
        throw new QaToolError('NO_ACTIVE_PAUSE', 'No Mocha test is currently paused.');
      }
      const view = toFailureContextView(active, input.response_format ?? 'concise');
      return jsonResult(view);
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
