/**
 * QA Debug Companion chat participant — `@qa-debug`.
 *
 * v5.3 implementation. Per ARCHITECTURE-CR-v5.3.md §2.1, the participant:
 *  - Reads MementoPauseStore.peekActivePause() (returns undefined cleanly when
 *    no pause exists — no try/catch needed per [R#3-B3]).
 *  - Streams deterministic Markdown context (test/file/failure/CDP/mode) on
 *    every turn — bypasses LLM hallucination risk per §4 cost analysis.
 *  - Surfaces decision buttons (Retry + Give Up in BOTH modes; only the
 *    qa_propose_close_browser MCP tool is declined in Mode A per v5.2 §2.6).
 *  - In Mode A appends a markdown footer noting browser ownership.
 *  - followupProvider proposes 3 investigation directions for proactive UX.
 *
 * The participant `name` is `qa-debug` so the `@qa-debug` token in
 * `workbench.action.chat.open` queries routes here. Verified at Phase 1
 * acceptance test #1 (§4.5).
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

    const modeLabel = active.mode === 'A' ? 'Mode A — your wdio session' : 'Mode B — companion-launched';

    stream.markdown(
      `### Active pause: \`${active.test_title}\`\n\n` +
        `**File:** \`${active.file}\`${active.line ? ` (line ${active.line})` : ''}\n\n` +
        `**Failure:** ${active.failing_assertion}\n\n` +
        `**Browser held at:** \`${active.cdp_ws_url}\` (${modeLabel})\n\n` +
        `The qa-debug + playwright-mcp tool surface is registered. ` +
        `Ask me to inspect the live browser, edit a selector, retry, give up, or mark as passed.`,
    );

    // [R#2-NB2] stream.button takes a vscode.Command object per vscode.d.ts:19938.
    // Command shape (vscode.d.ts:24-46): { title, command, tooltip?, arguments? }.
    // [R#2-NB5] Both Retry AND Give Up are decision verbs and work in both modes —
    // only qa_propose_close_browser is declined in Mode A per v5.2 §2.6.
    stream.button({
      command: 'qa-debug.retry',
      title: 'Retry (commit)',
    });
    stream.button({
      command: 'qa-debug.giveUp',
      title: 'Give Up (commit)',
    });

    if (active.mode === 'A') {
      stream.markdown(
        `\n\n_Note: in Mode A, your test code owns the browser via wdio.remote(). ` +
          `Close it via \`browser.deleteSession()\` in your test teardown — ` +
          `\`qa_propose_close_browser\` returns declined per v5.2 §2.6._`,
      );
    }

    appendInfo(channel, `[chat-participant] handled request for session=${active.session_id}`);
    return {};
  });

  participant.iconPath = new vscode.ThemeIcon('debug-alt');
  participant.followupProvider = {
    provideFollowups: (_result, _ctx, _token) => {
      const active = pauseStore.peekActivePause();
      if (!active) return [];
      return [
        { prompt: `Inspect the failing selector for "${active.test_title}"`, label: 'Inspect selector' },
        { prompt: `Show console logs for the held browser`, label: 'Console logs' },
        { prompt: `What was the failure root cause?`, label: 'Diagnose root cause' },
      ];
    },
  };

  context.subscriptions.push(participant);
  appendInfo(channel, `[chat-participant] registered @qa-debug`);
}
