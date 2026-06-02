import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';
import { appendInfo } from '../output-channel.js';
import { pickElementViaOverlay } from '../cdp-inspect.js';

const TOOL_NAME = 'qa-debug_qa_pick_element';

interface Input {
  session_id?: string;
}

/**
 * Arms Chrome's native DevTools element inspector (CDP Overlay) on the pause's
 * selected held browser so the QA points at the exact element a failing selector
 * should match. Pause-gated like the other verbs: it reads the committed chrome
 * selection from the pause store (no discovery here) and drives Overlay over a
 * raw CDP connection — see cdp-inspect.ts for why native (not a page-script
 * picker) is what makes this pierce iframes + shadow DOM transparently.
 */
export class PickElementTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, options.input);
    try {
      const { session_id } = options.input;
      const active = this.deps.pauseStore.getActivePause(session_id);
      if (!active) {
        throw new QaToolError('NO_ACTIVE_PAUSE', 'No Mocha test is currently paused.');
      }
      const port = active.selected_cdp_port;
      const chrome =
        port != null ? active.available_chromes.find((c) => c.port === port) : undefined;
      if (!chrome) {
        throw new QaToolError(
          'BROWSER_NOT_SELECTED',
          'No chrome is selected for this pause. Call qa_select_chrome first, then retry.',
        );
      }

      // Bridge the LM cancellation token to the picker's AbortSignal so the
      // inspector tears down promptly if the agent turn is cancelled.
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        const result = await pickElementViaOverlay(chrome.ws_url, {
          signal: controller.signal,
          log: (m) => appendInfo(this.deps.auditChannel, m),
        });
        return jsonResult(result);
      } finally {
        sub.dispose();
      }
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
