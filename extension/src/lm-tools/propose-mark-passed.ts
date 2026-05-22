import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_propose_mark_passed';

interface Input {
  session_id: string;
  rationale: string;
}

/**
 * CR-v5.14 §2.3 — propose verb with prepareInvocation confirmation chip.
 * On Continue: invoke writes the proposal slot, commits through DecisionRouter
 * (kind='mark_passed' is part of DecisionKind), returns accepted_at_ms.
 * On Cancel: invoke never runs; VS Code returns a rejection signal to the model.
 * Lost-race against Test Explorer markPassed button → PAUSE_ALREADY_RESOLVED.
 */
export class ProposeMarkPassedTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: 'Marking the failing test as passed',
      confirmationMessages: {
        title: 'Mark this failing test as passed?',
        message: new vscode.MarkdownString(
          `The agent is proposing to mark the paused test as **passed** with the following rationale:\n\n` +
            `> ${options.input.rationale}\n\n` +
            `Only continue if this is an environmental flake — not a real assertion failure.`,
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
      const proposal = this.deps.pauseStore.proposeAction(session_id, 'mark_passed', rationale);
      const committed = this.deps.decisionRouter.commit(session_id, 'mark_passed', rationale, 'agent');
      if (!committed) {
        throw new QaToolError(
          'PAUSE_ALREADY_RESOLVED',
          'Pause already resolved by another caller (likely Test Explorer button). ' +
            'Call qa_get_failure_context to ground in current state.',
        );
      }
      return jsonResult({
        proposal_id: proposal.proposal_id,
        status: 'accepted',
        accepted_at_ms: Date.now(),
      });
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
