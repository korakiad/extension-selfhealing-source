import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';
import { probePorts } from './probe-ports.js';

const TOOL_NAME = 'qa-debug_qa_discover_chromes';

interface Input {
  session_id: string;
  ports: number[];
}

/**
 * v5.16 PLAN-cdp-port-discovery §3.12 — re-probes user-supplied ports and
 * replaces the active pause's available_chromes. Side-effect on prior
 * selection: cleared iff prior port not in new list (fires onChromeDeselected
 * via pauseStore.replaceAvailableChromes). Callers must call qa_select_chrome
 * after this to commit a new selection.
 */
export class DiscoverChromesTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, options.input);
    try {
      const { session_id, ports } = options.input;
      // Validates session is active; throws NO_ACTIVE_PAUSE / SESSION_NOT_FOUND.
      this.deps.pauseStore.getActivePause(session_id);
      const chromes = await probePorts(ports);
      if (chromes.length === 0) {
        throw new QaToolError(
          'NO_CHROMES_FOUND',
          `None of the supplied ports [${ports.join(', ')}] responded to /json/version. ` +
            'Re-ask the user, or surface the framework launch failure.',
        );
      }
      const { cleared } = await this.deps.pauseStore.replaceAvailableChromes(session_id, chromes);
      return jsonResult({
        available_chromes: chromes,
        selection_cleared: cleared,
      });
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
