/**
 * Ambient status-bar entry indicating an active pause.
 *
 * ARCHITECTURE-CR-v5.4 §2.2 + §3.7. Augments (does not replace) the pause
 * notification toast per [B4] — the toast is ephemeral push, this entry is
 * ambient pull. Click action focuses Test Explorer (the primary surface per
 * §2.5 / [B3]).
 *
 * Lifecycle:
 *  - show(sessionId) at pause.publish and at stale-resume (per §3.7).
 *  - hide(sessionId) at decision commit (mark_passed / give_up / retry).
 *  - dispose() at extension deactivate.
 *
 * Tooltip is recomposed on each show() from MementoPauseStore.peekActivePause()
 * so it always reflects the current active pause (test title, file:line, Mode
 * A/B per v5.2, CDP URL).
 */

import * as vscode from 'vscode';

import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';

export interface PauseStatusBar {
  show(sessionId: string): void;
  hide(sessionId: string): void;
  dispose(): void;
}

export function registerPauseStatusBar(
  context: vscode.ExtensionContext,
  pauseStore: MementoPauseStore,
  channel: vscode.OutputChannel,
): PauseStatusBar {
  // vscode.d.ts:11643 three-arg overload — id is required for the typed form.
  const item = vscode.window.createStatusBarItem(
    'qa-debug.paused',
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = 'QA Debug — Paused indicator';
  item.command = 'workbench.view.testing.focus';

  const refreshTooltip = (): void => {
    const active = pauseStore.peekActivePause();
    if (!active) {
      item.tooltip = undefined;
      return;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**QA Debug — paused**\n\n`);
    md.appendMarkdown(`\`${active.test_title}\`\n\n`);
    md.appendMarkdown(
      `**File:** \`${active.file}\`${active.line ? ` (line ${active.line})` : ''}\n\n`,
    );
    md.appendMarkdown(
      `**Mode:** ${active.mode === 'A' ? 'A — your wdio session owns the browser' : 'B — companion-launched browser'}\n\n`,
    );
    md.appendMarkdown(`**CDP:** \`${active.cdp_ws_url}\`\n\n`);
    md.appendMarkdown(`Click to focus Test Explorer.`);
    item.tooltip = md;
  };

  const api: PauseStatusBar = {
    show(sessionId: string): void {
      item.text = '$(debug-alt) QA Paused';
      // vscode.d.ts:7613-7624 — only 'statusBarItem.errorBackground' or
      // '.warningBackground' are permitted; warning is right for "awaiting
      // decision" (not a terminal failure).
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      refreshTooltip();
      item.show();
      appendInfo(channel, `[status-bar] shown for session=${sessionId}`);
    },
    hide(sessionId: string): void {
      item.hide();
      appendInfo(channel, `[status-bar] hidden for session=${sessionId}`);
    },
    dispose(): void {
      item.dispose();
    },
  };

  context.subscriptions.push({ dispose: () => api.dispose() });
  return api;
}
