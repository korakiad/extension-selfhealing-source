import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';
import { resolveInspectTarget } from './inspect-target.js';
import { appendInfo } from '../output-channel.js';
import { pickElement } from '../element-picker.js';

const TOOL_NAME = 'qa-debug_qa_pick_element';

interface Input {
  session_id?: string;
}

/**
 * Arms Chrome's native DevTools element inspector (CDP Overlay) on the active
 * inspection's selected browser so the QA points at the exact element, then
 * returns a verification-ready description (computed role/accessibleName, an
 * injected data-qa-pick marker, match-counted CSS candidates). Gated like the
 * other verbs: it reads the committed chrome selection from the pause/live
 * store (no discovery here) — see element-picker.ts for why native Overlay
 * (not a page-script picker) pierces iframes + shadow DOM transparently, and
 * for what each returned handle is for.
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
      // Resolves from EITHER a Mocha pause OR a Live Inspect Session (mutually
      // exclusive); throws NO_ACTIVE_INSPECTION / SESSION_NOT_FOUND.
      const target = resolveInspectTarget(
        this.deps.pauseStore,
        this.deps.liveTargetStore,
        session_id,
      );
      const port = target.selected_cdp_port;
      const chrome =
        port != null ? target.available_chromes.find((c) => c.port === port) : undefined;
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
        const result = await pickElement(chrome.ws_url, {
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
