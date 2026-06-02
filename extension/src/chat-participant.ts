/**
 * QA Debug Companion chat participant — `@qa-debug`.
 *
 * Reads MementoPauseStore.peekActivePause() (returns undefined cleanly when
 * no pause exists). Streams deterministic Markdown context for the active
 * pause. A pause is a pure inspection hold — there is no verdict to commit;
 * the user re-runs the test via the standard ▶ Run button in Test Explorer
 * once the underlying cause is addressed, or ends the run with Stop.
 */

import * as vscode from 'vscode';

import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';

export function registerQaDebugChatParticipant(
  context: vscode.ExtensionContext,
  pauseStore: MementoPauseStore,
  channel: vscode.OutputChannel,
): void {
  // [R#2-NB9 runtime guard] — vscode.chat may be absent on engines.vscode
  // below the createChatParticipant landing version. Degrade gracefully.
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    appendInfo(
      channel,
      `[chat-participant] vscode.chat.createChatParticipant not available on this VS Code build; participant registration skipped (Skill description-driven engagement still works)`,
    );
    return;
  }

  const participant = vscode.chat.createChatParticipant('qa-debug', async (_request, _ctx, stream, _token) => {
    const active = pauseStore.peekActivePause();
    if (!active) {
      stream.markdown(
        `No Mocha test is currently paused under the QA Debug Companion. ` +
          `Run a fixture test from Test Explorer or via **QA Debug: Run Fixture Suite** to begin a session.`,
      );
      return {};
    }

    const browserLine =
      active.selected_cdp_port != null
        ? `A Chrome is selected (port ${active.selected_cdp_port}) and playwright-mcp is registered against the held browser — I can inspect it (DOM, targeted in-page JS, screenshots). `
        : `playwright-mcp isn't registered yet — a Chrome has to be selected first (the qa-debug skill handles this in Step 1b). Once that commits I can inspect the held browser (DOM, targeted in-page JS, screenshots). `;
    stream.markdown(
      `### Active pause: \`${active.test_title}\`\n\n` +
        `**File:** \`${active.file}\`${active.line ? ` (line ${active.line})` : ''}\n\n` +
        `**Failure:** ${active.failing_assertion}\n\n` +
        browserLine +
        `_Network and console reads are on-demand in beta — ask if you want them pulled._\n\n` +
        `This pause is a pure inspection hold — there's no pass/fail verdict to commit. ` +
        `Tell me what you'd like to investigate. After I propose a fix I'll ask if there's anything else to look at ` +
        `before you re-run; I'll propose edits in chat before applying them unless the session is on autopilot. ` +
        `When the underlying issue is addressed, re-run the test via ▶ Run in Test Explorer, or end the run with Stop.`,
    );

    appendInfo(channel, `[chat-participant] handled request for session=${active.session_id}`);
    return {};
  });

  participant.iconPath = new vscode.ThemeIcon('debug-alt');
  participant.followupProvider = {
    provideFollowups: (_result, _ctx, _token) => {
      const active = pauseStore.peekActivePause();
      if (!active) return [];
      return [
        { prompt: `Use the identify-element skill so I can pick the failing element in the held browser`, label: 'Pick failing element' },
        { prompt: `Show the network requests around the failure for the held browser`, label: 'Network requests' },
        { prompt: `What was the failure root cause?`, label: 'Diagnose root cause' },
      ];
    },
  };

  context.subscriptions.push(participant);
  appendInfo(channel, `[chat-participant] registered @qa-debug`);
}
