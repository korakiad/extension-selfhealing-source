import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';
import { probePorts } from './probe-ports.js';
import { getCdpPorts } from '../cdp-ports.js';

const TOOL_NAME = 'qa-debug_qa_start_live_session';

interface Input {
  cdp_port?: number;
}

/**
 * Re-establishes the CDP target for the ACTIVE Live Inspect Session. The
 * launcher (LiveSessionManager) already starts the session and auto-selects its
 * browser; this verb re-probes (after navigation / new tabs / restart) and
 * refreshes the live target. It does NOT create a session — that's the
 * "QA Debug: Inspect App" command's job (the launch is the trigger).
 */
export class StartLiveSessionTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, undefined);
    try {
      const live = this.deps.liveTargetStore.get();
      if (!live) {
        throw new QaToolError(
          'NO_ACTIVE_INSPECTION',
          'No Live Inspect Session is active. Launch one via "QA Debug: Inspect App" first.',
        );
      }

      const { cdp_port } = options.input;
      let ports: number[];
      if (cdp_port != null) {
        if (!Number.isInteger(cdp_port) || cdp_port < 1024 || cdp_port > 65535) {
          throw new QaToolError('INVALID_PORT', `Port ${cdp_port} is outside 1024-65535.`);
        }
        ports = [cdp_port];
      } else {
        // Prefer the session's current port; fall back to the configured pool.
        ports =
          live.selected_cdp_port != null ? [live.selected_cdp_port] : getCdpPorts();
      }

      const chromes = await probePorts(ports);
      if (chromes.length === 0) {
        throw new QaToolError(
          'NO_CHROMES_FOUND',
          `Nothing answered CDP on port(s) [${ports.join(', ')}] — the inspected app may have closed.`,
        );
      }
      // Keep the prior selection if it's still present; else take the first.
      const prior = live.selected_cdp_port;
      const selected =
        prior != null && chromes.some((c) => c.port === prior) ? prior : chromes[0].port;
      this.deps.liveTargetStore.set({
        session_id: live.session_id,
        available_chromes: chromes,
        selected_cdp_port: selected,
      });

      return jsonResult({ available_chromes: chromes, selected_cdp_port: selected });
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
