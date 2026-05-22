import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_propose_abort_suite';

interface Input {
  session_id: string;
  rationale: string;
}

/**
 * CR-v5.14 §2.3 — propose verb with prepareInvocation chip. On Continue, writes
 * proposal slot with status='awaiting_human'. Abort-suite fulfillment path is
 * deferred to Phase 2.
 */
export class ProposeAbortSuiteTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: 'Aborting the remaining Mocha suite',
      confirmationMessages: {
        title: 'Abort the remaining Mocha suite?',
        message: new vscode.MarkdownString(
          `The agent is proposing to abort the remaining suite with rationale:\n\n` +
            `> ${options.input.rationale}\n\n` +
            `**This destroys remaining test work in the current run.** ` +
            `Only continue for cross-test blocking failures (config / credential / infra).`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, options.input);
    try {
      const { session_id, rationale } = options.input;
      const proposal = this.deps.pauseStore.proposeAction(session_id, 'abort_suite', rationale);
      return jsonResult({
        proposal_id: proposal.proposal_id,
        status: proposal.status,
      });
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
