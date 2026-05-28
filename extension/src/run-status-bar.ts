/**
 * Ambient status-bar entry indicating an active fixture-suite run.
 *
 * Mirrors `pause-status-bar.ts` so the QA always has a one-click cancel surface
 * when they realize they ran the wrong fixture. SessionManager toggles show/hide
 * around spawnMochaChild / onMochaExit. Click invokes qa-debug.cancelRun (which
 * carries the modal "Cancel Suite" confirm).
 */

import * as vscode from 'vscode';

import { appendInfo } from './output-channel.js';

export interface RunStatusBar {
  show(): void;
  hide(): void;
  dispose(): void;
}

export function registerRunStatusBar(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): RunStatusBar {
  const item = vscode.window.createStatusBarItem(
    'qa-debug.running',
    vscode.StatusBarAlignment.Left,
    // Lower priority than pause (100) so the pause indicator wins the leftmost
    // slot when both are visible.
    99,
  );
  item.name = 'QA Debug — Running suite indicator';
  item.text = '$(debug-stop) Cancel Suite';
  item.tooltip = 'QA Debug: cancel the running fixture suite (SIGTERM mocha).';
  item.command = 'qa-debug.cancelRun';

  const api: RunStatusBar = {
    show(): void {
      item.show();
      appendInfo(channel, '[status-bar] running indicator shown');
    },
    hide(): void {
      item.hide();
      appendInfo(channel, '[status-bar] running indicator hidden');
    },
    dispose(): void {
      item.dispose();
    },
  };

  context.subscriptions.push({ dispose: () => api.dispose() });
  return api;
}
