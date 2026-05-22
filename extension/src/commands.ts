/**
 * qa-debug.* commands per `extension/package.json contributes.commands`:
 *  - qa-debug.runFixture          — spawn the fixture suite (entry point)
 *  - qa-debug.retry               — commit retry (reversible; no UI confirm)
 *  - qa-debug.giveUp              — commit give_up (reversible; no UI confirm)
 *  - qa-debug.markPassed          — commit mark_passed (irreversible; UI confirm
 *                                   for proposals, showInputBox prompt for cold clicks
 *                                   per S4_DESIGN §8.2 case 3 [R#3-B1c])
 *  - qa-debug.openChatForPaused   — open Copilot Chat with a prefilled prompt
 *                                   describing the pause (CR-v5.6 §2.2 / §3.8.1)
 */

import * as vscode from 'vscode';

import type { DecisionKind } from '@qa-debug/mocha-hooks/protocol';
import type { PausePayload } from '@qa-debug/pause-store-types';

import type { DecisionRouter } from './decision-router.js';
import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';
import type { SessionManager } from './session-manager.js';

export interface CommandDeps {
  pauseStore: MementoPauseStore;
  decisionRouter: DecisionRouter;
  sessionManager: SessionManager;
  channel: vscode.OutputChannel;
}

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
let chatOpenAvailableCache: boolean | undefined;

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.runFixture', () => runFixtureCmd(deps)),
    vscode.commands.registerCommand('qa-debug.retry', () => decisionCmd(deps, 'retry')),
    vscode.commands.registerCommand('qa-debug.giveUp', () => decisionCmd(deps, 'give_up')),
    vscode.commands.registerCommand('qa-debug.markPassed', () => markPassedCmd(deps)),
    vscode.commands.registerCommand('qa-debug.openChatForPaused', () => openChatForPausedCmd(deps)),
  );
}

async function runFixtureCmd(deps: CommandDeps): Promise<void> {
  try {
    // qa-debug.runFixture command invokes with no specs; SessionManager.resolveCwd
    // falls back to fixture-tests/ (legacy demo) or workspaceRoot.
    await deps.sessionManager.runFixtureSuite();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendInfo(deps.channel, `[command] runFixture failed: ${msg}`);
    void vscode.window.showErrorMessage(`QA Debug: failed to start fixture suite — ${msg}`);
  }
}

/** Reversible verbs (retry / give_up) commit immediately through DecisionRouter. */
async function decisionCmd(deps: CommandDeps, kind: 'retry' | 'give_up'): Promise<void> {
  let active;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }
  const verb = kind === 'retry' ? 'Retry' : 'Give Up';
  const reason = `user clicked ${verb} in Test Explorer`;
  const ok = deps.decisionRouter.commit(active.session_id, kind as DecisionKind, reason, 'human');
  if (!ok) {
    void vscode.window.showErrorMessage('QA Debug: Pause already resolved.');
  }
}

/** Mark-passed: proposal-driven path or cold-click with showInputBox guard. */
async function markPassedCmd(deps: CommandDeps): Promise<void> {
  let active;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }

  const proposal = deps.pauseStore.pollProposal(active.session_id);
  let rationale: string;
  let by: 'human' | 'agent';

  if (proposal && proposal.kind === 'mark_passed') {
    // Proposal-driven: the agent already supplied the rationale; the human is
    // committing it. We still attribute `by: 'human'` because the commit was a
    // human click; the agent's role is captured in the proposal/rationale text.
    rationale = proposal.rationale;
    by = 'human';
  } else {
    // Cold click — prompt for a rationale. validateInput blocks OK-with-empty
    // per S4_DESIGN §8.2 case 3 [R#3-B1c]; Escape returns undefined.
    const input = await vscode.window.showInputBox({
      prompt: 'Why mark this test as passed?',
      placeHolder: 'Specific, falsifiable rationale — what makes this a real pass?',
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length === 0 ? 'Rationale required (be specific and falsifiable)' : null,
    });
    if (!input?.trim()) {
      // User cancelled (Escape) — leave the pause open. validateInput should
      // have prevented empty-OK, but belt-and-suspenders.
      return;
    }
    rationale = input.trim();
    by = 'human';
  }

  const ok = deps.decisionRouter.commit(active.session_id, 'mark_passed', rationale, by);
  if (!ok) {
    void vscode.window.showErrorMessage('QA Debug: Pause already resolved.');
  }
}

/**
 * CR-v5.6 §3.8.1 — open Copilot Chat with a deterministic prefilled prompt
 * describing the active pause. Feature-detects `workbench.action.chat.open`;
 * falls back to clipboard + chat-view-focus when unavailable.
 */
async function openChatForPausedCmd(deps: CommandDeps): Promise<void> {
  let active: PausePayload;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }

  const prompt = buildPausePrompt(active);
  const fileUri = vscode.Uri.file(active.file);

  if (await isChatOpenAvailable()) {
    // CR-v5.6 §2.2 / iter#1 manual-QA fix 2026-05-22:
    //  - `toolIds` dropped: ['playwright-mcp', 'qa-debug'] are MCP *server*
    //    names, not LanguageModelTool ids; Copilot's chat panel crashed
    //    trying to render tool-chips for unknown ids. Agent mode
    //    auto-discovers MCP tools when the gate is open, so explicit
    //    toolIds adds no signal.
    //  - attachFiles range dropped: chatActions.ts main-branch schema
    //    expects Monaco IRange (startLineNumber/...) but vscode.Range
    //    serializes to {start, end}. Bare URI attaches the spec file
    //    without the (cosmetic) cursor anchor.
    await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
      query: prompt,
      isPartialQuery: false,
      mode: 'agent',
      attachFiles: [fileUri],
    });
    appendInfo(deps.channel, `[command] openChatForPaused session=${active.session_id}`);
  } else {
    await vscode.env.clipboard.writeText(prompt);
    void vscode.commands.executeCommand('workbench.view.chat.focus').then(undefined, () => undefined);
    void vscode.window.showInformationMessage(
      'QA Debug: prompt copied to clipboard — paste into Chat. (workbench.action.chat.open unavailable on this VS Code build.)',
    );
    appendInfo(deps.channel, '[command] openChatForPaused fallback (clipboard)');
  }
}

export function buildPausePrompt(pause: PausePayload): string {
  return [
    'A Mocha test is paused at the failure point. Please investigate using the qa-debug + playwright-mcp tools.',
    '',
    `Test: ${pause.full_title}`,
    `File: ${pause.file}:${pause.line ?? '?'}`,
    `Failure: ${pause.failing_assertion}`,
    `Browser (CDP): ${pause.cdp_ws_url}`,
    '',
    'Start by calling qa-debug_qa_get_failure_context for grounded context, then use playwright-mcp:browser_snapshot or :browser_evaluate to inspect live DOM. The browser at the CDP endpoint above is the same Chrome window that was open when the test failed.',
  ].join('\n');
}

async function isChatOpenAvailable(): Promise<boolean> {
  if (chatOpenAvailableCache !== undefined) return chatOpenAvailableCache;
  const all = await vscode.commands.getCommands(true);
  chatOpenAvailableCache = all.includes(CHAT_OPEN_COMMAND);
  return chatOpenAvailableCache;
}
