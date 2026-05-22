import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';

const TOOL_NAME = 'qa-debug_qa_propose_close_browser';

interface Input {
  session_id: string;
  rationale: string;
}

/**
 * CR-v5.14 §2.3 — Mode A (transparent wdio.remote integration) declines without
 * a chip because the user's test code owns the browser lifecycle via
 * browser.deleteSession(). Mode B → prepareInvocation chip; on Continue, writes
 * proposal slot with status='awaiting_human' (Phase 1 close-browser fulfillment
 * path is deferred; SessionManager will observe the proposal in Phase 2).
 *
 * prepareInvocation must be side-effect-free per vscode.d.ts:21174; the Mode A
 * branch therefore runs in invoke (not prepare). The chip surfaces for both
 * modes; Mode A returns declined immediately from invoke; the user clicks
 * Continue but learns from the result that the close did not happen.
 *
 * Phase 2 alternative: prepareInvocation could read pauseStore (read-only,
 * side-effect-free) to short-circuit the chip for Mode A. Currently both
 * decisions land in invoke for simplicity.
 */
export class ProposeCloseBrowserTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: 'Closing the held debugging browser',
      confirmationMessages: {
        title: 'Close the held debugging browser?',
        message: new vscode.MarkdownString(
          `The agent is proposing to close the held Chrome at the pause's CDP endpoint with rationale:\n\n` +
            `> ${options.input.rationale}\n\n` +
            `**This destroys the live inspection state — DOM, console history, network state.** ` +
            `Only continue if investigation is complete.`,
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
      const active = this.deps.pauseStore.getActivePause(session_id);
      if (!active) {
        throw new QaToolError('NO_ACTIVE_PAUSE', 'No Mocha test is currently paused.');
      }
      // v5.2 §2.6 Mode A decline — user's test code owns the browser.
      if (active.mode === 'A') {
        return jsonResult({
          proposal_id: '',
          status: 'declined',
          reason:
            'browser is owned by your test code (Mode A); close it via ' +
            'browser.deleteSession() in your test teardown. The QA Debug Companion ' +
            'does not close a browser it does not own. See ARCHITECTURE-CR-v5.2 §2.6.',
        });
      }
      const proposal = this.deps.pauseStore.proposeAction(session_id, 'close_browser', rationale);
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
