/**
 * Ambient status-bar entry indicating an active pause.
 *
 * ARCHITECTURE-CR-v5.4 §2.2 + §3.7. Augments (does not replace) the pause
 * notification toast per [B4] — the toast is ephemeral push, this entry is
 * ambient pull.
 *
 * v5.16 PLAN-cdp-port-discovery §3.14 — text + command branch by chrome
 * selection state:
 *  - selection committed (auto or explicit) → text "QA Paused", click focuses
 *    Test Explorer.
 *  - available_chromes.length === 0, no selection → text "Enter Chrome ports",
 *    click runs qa-debug.enterChromePorts InputBox.
 *  - available_chromes.length >= 2, no selection → text "Select Chrome", click
 *    runs qa-debug.selectChrome QuickPick.
 *
 * Re-renders on PauseStore selection events so the click target stays in sync.
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

  const render = (): void => {
    const active = pauseStore.peekActivePause();
    if (!active) {
      item.tooltip = undefined;
      item.text = '';
      item.command = undefined;
      return;
    }
    const chromes = active.available_chromes;
    const selected = active.selected_cdp_port;
    const owner = active.chrome_owner;

    let text: string;
    let command: string;
    if (selected != null) {
      text = '$(debug-alt) QA Paused';
      command = 'workbench.view.testing.focus';
    } else if (chromes.length === 0) {
      text = '$(question) Enter Chrome ports';
      command = 'qa-debug.enterChromePorts';
    } else {
      text = `$(list-selection) Select Chrome (${chromes.length})`;
      command = 'qa-debug.selectChrome';
    }
    item.text = text;
    item.command = command;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**QA Debug — paused**\n\n`);
    md.appendMarkdown(`\`${active.test_title}\`\n\n`);
    md.appendMarkdown(
      `**File:** \`${active.file}\`${active.line ? ` (line ${active.line})` : ''}\n\n`,
    );
    md.appendMarkdown(`**Chrome owner:** ${owner}\n\n`);
    if (selected != null) {
      const sel = chromes.find((c) => c.port === selected);
      md.appendMarkdown(`**Selected chrome port:** \`${selected}\`\n\n`);
      if (sel?.ws_url) md.appendMarkdown(`**CDP:** \`${sel.ws_url}\`\n\n`);
      md.appendMarkdown(`Click to focus Test Explorer.`);
    } else if (chromes.length === 0) {
      md.appendMarkdown(
        `_No Chrome found at default debug ports. Click to enter the port(s) your framework launches Chrome on._\n\n`,
      );
    } else {
      md.appendMarkdown(
        `_${chromes.length} candidate Chromes discovered. Click to pick one._\n\n`,
      );
      for (const c of chromes) {
        const titles = c.page_titles.length > 0 ? ` — ${c.page_titles.join(' / ')}` : '';
        md.appendMarkdown(`- port \`${c.port}\`${titles}\n`);
      }
    }
    item.tooltip = md;
  };

  // Re-render on selection-state changes so click target stays accurate.
  const subs = [
    pauseStore.onChromeSelected(() => render()),
    pauseStore.onChromeDeselected(() => render()),
  ];

  const api: PauseStatusBar = {
    show(sessionId: string): void {
      // vscode.d.ts:7613-7624 — only 'statusBarItem.errorBackground' or
      // '.warningBackground' permitted; warning is right for "awaiting decision".
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      render();
      item.show();
      appendInfo(channel, `[status-bar] shown for session=${sessionId}`);
    },
    hide(sessionId: string): void {
      item.hide();
      appendInfo(channel, `[status-bar] hidden for session=${sessionId}`);
    },
    dispose(): void {
      for (const s of subs) s.dispose();
      item.dispose();
    },
  };

  context.subscriptions.push({ dispose: () => api.dispose() });
  return api;
}
