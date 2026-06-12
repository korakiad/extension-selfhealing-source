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

import { getCdpPorts } from './cdp-ports.js';
import type { LiveSessionManager } from './live-session-manager.js';
import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

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

export function registerQaTestcaseChatParticipant(
  context: vscode.ExtensionContext,
  liveSessionManager: LiveSessionManager,
  channel: vscode.OutputChannel,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    appendInfo(
      channel,
      `[chat-participant] vscode.chat.createChatParticipant not available on this VS Code build; @qa-testcase registration skipped`,
    );
    return;
  }

  const participant = vscode.chat.createChatParticipant('qa-testcase', async (request, _ctx, stream, _token) => {
    const liveMode = await ensureLiveInspectionForTestcase(liveSessionManager);
    if (liveMode === undefined) {
      stream.markdown(
        `No Live Inspect Session is ready. Run \`@qa-testcase /generate <case-id> auto\` again when you're ready, or choose the repo-only path.`,
      );
      appendInfo(channel, `[chat-participant] @qa-testcase cancelled before route command=${request.command ?? 'default'}`);
      return {};
    }

    const prompt = buildTestcaseWriterPrompt(request.command, request.prompt, liveMode);
    const opened = await openInTestcaseWriter(prompt);
    if (opened) {
      stream.markdown(
        `Opening Chat with the **QA Testcase Writer** request. If VS Code doesn't switch modes automatically, select **QA Testcase Writer** from the agent picker. Use \`@qa-testcase /generate <case-id> auto\` or \`manual\` next time if you want to make the mode explicit.`,
      );
      appendInfo(channel, `[chat-participant] routed @qa-testcase command=${request.command ?? 'default'}`);
      return {};
    }

    await vscode.env.clipboard.writeText(prompt);
    stream.markdown(
      `I couldn't switch to the **qa-testcase-writer** agent on this VS Code build. ` +
        `I copied the prepared prompt to the clipboard; open Chat, select **QA Testcase Writer**, and paste it.`,
    );
    appendInfo(channel, `[chat-participant] @qa-testcase fallback copied prompt command=${request.command ?? 'default'}`);
    return {};
  });

  participant.iconPath = new vscode.ThemeIcon('checklist');
  participant.followupProvider = {
    provideFollowups: () => [
      { prompt: `/generate C12345 auto`, label: 'Generate from case' },
      { prompt: `/generate C12345 manual`, label: 'Manual plan first' },
    ],
  };

  context.subscriptions.push(participant);
  appendInfo(channel, `[chat-participant] registered @qa-testcase`);
}

type TestcaseLiveMode =
  | 'active-live-session'
  | 'launched-live-session'
  | 'attached-live-session'
  | 'repo-only';

async function ensureLiveInspectionForTestcase(
  liveSessionManager: LiveSessionManager,
): Promise<TestcaseLiveMode | undefined> {
  if (liveSessionManager.isActive()) {
    return (await confirmAppReadyForTestcase(liveSessionManager.activePort())) ? 'active-live-session' : undefined;
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(inspect) Launch app for MCP inspection',
        description: 'Recommended for UI cases',
        detail: 'Opens Web / Electron / OpenFin through QA Debug: Inspect App, then runs the testcase writer with qa-debug-cdp attached.',
        value: 'launch' as const,
      },
      {
        label: '$(plug) Attach existing CDP port',
        description: 'Reuse a logged-in app',
        detail: 'Probe a Web / Electron / OpenFin app that is already running with a remote-debugging port, then bind qa-debug-cdp without relaunching.',
        value: 'attach' as const,
      },
      {
        label: '$(file-code) Continue from repo only',
        description: 'No live browser',
        detail: 'Use TestRail plus workspace patterns. The agent will ask later if live inspection becomes necessary.',
        value: 'repo-only' as const,
      },
    ],
    {
      placeHolder: 'QA Testcase Writer needs a Live Inspect Session for browser MCP. How should I proceed?',
      ignoreFocusOut: true,
    },
  );

  if (!choice) return undefined;
  if (choice.value === 'repo-only') return 'repo-only';

  if (choice.value === 'attach') {
    const attached = await promptAndAttachExistingPort(liveSessionManager);
    if (!attached) return undefined;
    return (await confirmAppReadyForTestcase(liveSessionManager.activePort())) ? 'attached-live-session' : undefined;
  }

  await vscode.commands.executeCommand('qa-debug.launchInspectApp', { announce: false });
  if (!liveSessionManager.isActive()) return undefined;
  return (await confirmAppReadyForTestcase(liveSessionManager.activePort())) ? 'launched-live-session' : undefined;
}

async function promptAndAttachExistingPort(liveSessionManager: LiveSessionManager): Promise<boolean> {
  const defaultPort = getCdpPorts()[0] ?? 22135;
  const raw = await vscode.window.showInputBox({
    prompt: 'CDP debug port to attach',
    placeHolder: String(defaultPort),
    value: String(defaultPort),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v.trim());
      return Number.isInteger(n) && n >= 1024 && n <= 65535
        ? null
        : 'Enter an integer port between 1024 and 65535.';
    },
  });
  if (!raw) return false;
  return liveSessionManager.attachExisting(Number(raw.trim()), { announce: false });
}

async function confirmAppReadyForTestcase(port: number | undefined): Promise<boolean> {
  const portLabel = port ? ` on port ${port}` : '';
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(check) Continue now',
        detail: `The app is logged in and at the right starting state${portLabel}.`,
        value: 'continue' as const,
      },
      {
        label: '$(account) I need to log in or prepare state first',
        detail: 'Leave the app open; click Continue in the next prompt after login/navigation is done.',
        value: 'wait' as const,
      },
    ],
    {
      placeHolder: `Is the inspected app ready for testcase generation${portLabel}?`,
      ignoreFocusOut: true,
    },
  );

  if (!choice) return false;
  if (choice.value === 'continue') return true;

  const done = await vscode.window.showInformationMessage(
    `Log in or navigate the inspected app${portLabel}, then click Continue to start QA Testcase Writer.`,
    { modal: false },
    'Continue',
    'Cancel',
  );
  return done === 'Continue';
}

function buildTestcaseWriterPrompt(
  command: string | undefined,
  rawPrompt: string,
  liveMode: TestcaseLiveMode,
): string {
  const userPrompt = rawPrompt.trim();
  const mode = inferMode(userPrompt);
  const commandLine = command ? `/${command}` : '@qa-testcase';
  const liveLine =
    liveMode === 'repo-only'
      ? 'Live Inspect Session: not active. Work repo-first; ask the QA to launch inspection before any MCP/browser step.'
      : liveMode === 'attached-live-session'
        ? 'Live Inspect Session: attached to an existing CDP port. Use qa-debug-cdp for browser MCP when repo evidence is insufficient; do not relaunch or close the app.'
        : 'Live Inspect Session: active. Use qa-debug-cdp for browser MCP when repo evidence is insufficient.';

  return [
    'Use the test-script-orchestrator skill in the qa-testcase-writer agent.',
    '',
    `Launcher: ${commandLine}`,
    `User request: ${userPrompt || '(no case details provided yet)'}`,
    `Mode: ${mode ?? 'not specified — run Step 0 and ask Auto or Manual before editing'}`,
    liveLine,
    '',
    'If a TestRail case ID, case URL, BDD reference, or step list is present, read it through the TestRail tool first.',
    'Learn the workspace pattern before writing. Reuse existing page objects, selectors, helpers, waits, and assertions.',
    'When live-browser MCP inspection is ambiguous, pause and ask the QA one concrete question, then continue from the same step.',
    'For WebdriverIO without a local auto-wait wrapper, add explicit waits around UI interactions and assertions.',
  ].join('\n');
}

function inferMode(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\bmanual\b/.test(lower) || lower.includes('review first') || lower.includes('ask before')) {
    return 'Manual';
  }
  if (/\bauto\b/.test(lower) || lower.includes('go ahead') || lower.includes('ทำให้เลย')) {
    return 'Auto';
  }
  return undefined;
}

async function openInTestcaseWriter(prompt: string): Promise<boolean> {
  const attempts: Array<() => Thenable<unknown>> = [
    () =>
      vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
        query: prompt,
        isPartialQuery: false,
        mode: 'qa-testcase-writer',
      }),
    () => vscode.commands.executeCommand(CHAT_OPEN_COMMAND, { query: prompt, isPartialQuery: false }),
  ];

  for (const run of attempts) {
    try {
      await run();
      return true;
    } catch {
      // Try the next chat-open shape.
    }
  }
  return false;
}
