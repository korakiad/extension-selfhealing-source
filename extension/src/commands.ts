/**
 * Four qa-debug.* commands per `extension/package.json contributes.commands`:
 *  - qa-debug.runFixture   — spawn the fixture suite (entry point)
 *  - qa-debug.retry        — commit retry (reversible; no UI confirm)
 *  - qa-debug.giveUp       — commit give_up (reversible; no UI confirm)
 *  - qa-debug.markPassed   — commit mark_passed (irreversible; UI confirm
 *                            for proposals, showInputBox prompt for cold clicks
 *                            per S4_DESIGN §8.2 case 3 [R#3-B1c])
 *
 * Reversible verbs go straight through DecisionRouter. Mark-passed:
 *  - If a `mark_passed` proposal exists for the active pause, commit it with
 *    the proposal's rationale (the agent already supplied it).
 *  - Else (cold click), prompt the user for a rationale; validateInput blocks
 *    OK-with-empty; Escape aborts and leaves the pause open.
 */

import * as vscode from 'vscode';

import type { DecisionKind } from '@qa-debug/mocha-hooks/protocol';

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

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.runFixture', () => runFixtureCmd(deps)),
    vscode.commands.registerCommand('qa-debug.retry', () => decisionCmd(deps, 'retry')),
    vscode.commands.registerCommand('qa-debug.giveUp', () => decisionCmd(deps, 'give_up')),
    vscode.commands.registerCommand('qa-debug.markPassed', () => markPassedCmd(deps)),
  );
}

async function runFixtureCmd(deps: CommandDeps): Promise<void> {
  try {
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
