import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_request_give_up';

interface Input {
  session_id: string;
  reason: string;
}

export class RequestGiveUpTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, options.input);
    try {
      const { session_id, reason } = options.input;
      const result = this.deps.pauseStore.recordDecision(session_id, 'give_up', reason);
      const committed = this.deps.decisionRouter.commit(session_id, 'give_up', reason, 'agent');
      if (!committed) {
        throw new QaToolError(
          'PAUSE_ALREADY_RESOLVED',
          'Pause already resolved by another caller; no give_up effect was triggered. ' +
            'Call qa_get_failure_context (omit session_id) to ground in current state, ' +
            'then re-classify if a new pause arrived. Do NOT re-issue against the stale session_id.',
        );
      }
      return jsonResult(result);
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
