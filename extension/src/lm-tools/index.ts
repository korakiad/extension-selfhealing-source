/**
 * Entry point: register the qa-debug Language Model Tools on extension
 * activation. Visibility is gated per-tool by the `when: "qa-debug.paused"`
 * clause in package.json contributes.languageModelTools (CR-v5.14 §3.4); this
 * file is the runtime registration step required by
 * vscode.d.ts:20779 — *"A tool must also be registered in the package.json
 * languageModelTools contribution point."*
 */

import * as vscode from 'vscode';

import { DiscoverChromesTool } from './discover-chromes.js';
import { GetFailureContextTool } from './get-failure-context.js';
import { ProposeAbortSuiteTool } from './propose-abort-suite.js';
import { ProposeMarkPassedTool } from './propose-mark-passed.js';
import { RequestGiveUpTool } from './request-give-up.js';
import { SelectChromeTool } from './select-chrome.js';
import type { LmToolDeps } from './base.js';

export function registerQaDebugLmTools(
  context: vscode.ExtensionContext,
  deps: LmToolDeps,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('qa-debug_qa_get_failure_context', new GetFailureContextTool(deps)),
    vscode.lm.registerTool('qa-debug_qa_request_give_up', new RequestGiveUpTool(deps)),
    vscode.lm.registerTool('qa-debug_qa_propose_mark_passed', new ProposeMarkPassedTool(deps)),
    vscode.lm.registerTool('qa-debug_qa_propose_abort_suite', new ProposeAbortSuiteTool(deps)),
    // v5.16 PLAN-cdp-port-discovery — Mode C discovery + selection.
    vscode.lm.registerTool('qa-debug_qa_discover_chromes', new DiscoverChromesTool(deps)),
    vscode.lm.registerTool('qa-debug_qa_select_chrome', new SelectChromeTool(deps)),
  );
}
