/**
 * Entry point: register the qa-debug Language Model Tools on extension
 * activation. Visibility is gated per-tool by the `when: "qa-debug.paused"`
 * clause in package.json contributes.languageModelTools; this
 * file is the runtime registration step required by
 * code.visualstudio.com/api/extension-guides/tools#registering-a-language-model-tool.
 *
 * Verdict verbs removed (2026-05-31): a pause is a pure inspection hold —
 * no mark-passed / give-up / abort-suite verbs. The surviving tools ground the
 * agent (get_failure_context) and let it land on a dialable browser
 * (discover/select chrome). The QA re-runs from Test Explorer or ends the run
 * with Stop; the test stands at its natural Mocha outcome.
 */

import * as vscode from 'vscode';

import { DiscoverChromesTool } from './discover-chromes.js';
import { GetFailureContextTool } from './get-failure-context.js';
import { PickElementTool } from './pick-element.js';
import { SelectChromeTool } from './select-chrome.js';
import { StartLiveSessionTool } from './start-live-session.js';
import { TestRailGetTool } from './testrail-get.js';
import { TestRailPostTool } from './testrail-post.js';
import type { LmToolDeps } from './base.js';

export function registerQaDebugLmTools(
  context: vscode.ExtensionContext,
  deps: LmToolDeps,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('qa-debug_qa_get_failure_context', new GetFailureContextTool(deps)),
    // v5.16 — Mode C discovery + selection.
    vscode.lm.registerTool('qa-debug_qa_discover_chromes', new DiscoverChromesTool(deps)),
    vscode.lm.registerTool('qa-debug_qa_select_chrome', new SelectChromeTool(deps)),
    // CDP-native element inspector (Overlay) — pierces iframes + shadow DOM.
    // Works in a pause OR a Live Inspect Session (when: paused || liveSession).
    vscode.lm.registerTool('qa-debug_qa_pick_element', new PickElementTool(deps)),
    // Live Inspect Session primitive — (re)establish the live CDP target
    // (when: qa-debug.liveSession).
    vscode.lm.registerTool('qa-debug_qa_start_live_session', new StartLiveSessionTool(deps)),
    // TestRail API v2 access (no `when` clause — not pause-gated). The post
    // tool's prepareInvocation is the write-confirmation mechanism.
    vscode.lm.registerTool('qa-debug_qa_testrail_get', new TestRailGetTool(deps)),
    vscode.lm.registerTool('qa-debug_qa_testrail_post', new TestRailPostTool(deps)),
  );
}
