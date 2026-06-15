/**
 * QA Debug Companion chat participants.
 *
 * `@qa-debug` — reads MementoPauseStore.peekActivePause() (returns undefined
 * cleanly when no pause exists) and streams deterministic Markdown context for
 * the active pause. A pause is a pure inspection hold — there is no verdict to
 * commit; the user re-runs the test via ▶ Run in Test Explorer once the cause
 * is addressed, or ends the run with Stop.
 *
 * `@qa-agent` — the single QA companion entry: it ensures a Live Inspect Session
 * (launch / attach / repo-only), then routes the request into the `qa-automation`
 * custom agent, which handles BOTH live inspection and testcase authoring. The
 * `/generate` command (or a TestRail case id) selects the testcase prompt; a
 * bare mention gets a neutral inspection prompt so it does not over-steer toward
 * writing a testcase when the QA only wants to look at the app.
 */

import * as vscode from 'vscode';

import { promptForCdpPort } from './cdp-ports.js';
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

export function registerQaAgentChatParticipant(
  context: vscode.ExtensionContext,
  liveSessionManager: LiveSessionManager,
  channel: vscode.OutputChannel,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    appendInfo(
      channel,
      `[chat-participant] vscode.chat.createChatParticipant not available on this VS Code build; @qa-agent registration skipped`,
    );
    return;
  }

  // Sessions whose "app is logged in / ready" confirmation already happened —
  // follow-up @qa-agent messages skip the QuickPick gate until the session
  // changes. Keyed by sessionId, so a stop/relaunch re-asks.
  const confirmedReadySessions = new Set<string>();

  const participant = vscode.chat.createChatParticipant('qa-agent', async (request, _ctx, stream, _token) => {
    const liveMode = await ensureLiveInspection(liveSessionManager, confirmedReadySessions);
    if (liveMode === undefined) {
      // Tell the truth about session state: a launch/attach may have succeeded
      // (announce was suppressed) even though the readiness confirm did not.
      if (liveSessionManager.isActive()) {
        const port = liveSessionManager.activePort();
        stream.markdown(
          `The Live Inspect Session is still running${port ? ` on port ${port}` : ''} — the status bar shows it, ` +
            `and **QA Debug: Stop Live Inspect Session** stops it. ` +
            `When the app is logged in and at the right starting state, message **@qa-agent** again and I'll continue without relaunching.`,
        );
      } else {
        stream.markdown(
          `Cancelled — no Live Inspect Session was started. Message **@qa-agent** again when you're ready, or choose the repo-only path.`,
        );
      }
      appendInfo(channel, `[chat-participant] @qa-agent cancelled before route command=${request.command ?? 'default'} sessionActive=${liveSessionManager.isActive()}`);
      return {};
    }

    const port = liveSessionManager.activePort();
    const prompt = buildQaAgentPrompt(request.command, request.prompt, liveMode, port);
    const opened = await openInQaAgent(prompt);
    if (opened) {
      stream.markdown(
        `Opening Chat in **QA Automation**. If VS Code doesn't switch modes automatically, select **qa-automation** from the agent picker.`,
      );
      appendInfo(channel, `[chat-participant] routed @qa-agent command=${request.command ?? 'default'}`);
      return {};
    }

    await vscode.env.clipboard.writeText(prompt);
    stream.markdown(
      `I couldn't switch to the **qa-automation** agent on this VS Code build. ` +
        `I copied the prepared prompt to the clipboard; open Chat, select **qa-automation**, and paste it.`,
    );
    appendInfo(channel, `[chat-participant] @qa-agent fallback copied prompt command=${request.command ?? 'default'}`);
    return {};
  });

  participant.iconPath = new vscode.ThemeIcon('beaker');
  // No followupProvider: canned followups would submit a placeholder case id
  // (e.g. C12345) into the real flow. The response text teaches the syntax.

  context.subscriptions.push(participant);
  appendInfo(channel, `[chat-participant] registered @qa-agent`);
}

type LiveMode =
  | 'active-live-session'
  | 'launched-live-session'
  | 'attached-live-session'
  | 'repo-only';

async function ensureLiveInspection(
  liveSessionManager: LiveSessionManager,
  confirmedReadySessions: Set<string>,
): Promise<LiveMode | undefined> {
  if (liveSessionManager.isActive()) {
    const sessionId = liveSessionManager.activeSessionId();
    if (sessionId && confirmedReadySessions.has(sessionId)) return 'active-live-session';
    return (await confirmAndRemember(liveSessionManager, confirmedReadySessions)) ? 'active-live-session' : undefined;
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(inspect) Launch app for MCP inspection',
        description: 'Recommended for UI work',
        detail: 'Opens Web / Electron / OpenFin through QA Debug: Inspect App, then runs the QA Agent with qa-debug-cdp attached.',
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
        detail: 'Work from the repo (and TestRail when relevant). The agent will ask later if live inspection becomes necessary.',
        value: 'repo-only' as const,
      },
    ],
    {
      placeHolder: 'QA Agent needs a Live Inspect Session for browser MCP. How should I proceed?',
      ignoreFocusOut: true,
    },
  );

  if (!choice) return undefined;
  if (choice.value === 'repo-only') return 'repo-only';

  if (choice.value === 'attach') {
    const port = await promptForCdpPort('CDP debug port to attach');
    if (port === undefined) return undefined;
    if (!(await liveSessionManager.attachExisting(port, { announce: false }))) return undefined;
    return (await confirmAndRemember(liveSessionManager, confirmedReadySessions)) ? 'attached-live-session' : undefined;
  }

  await vscode.commands.executeCommand('qa-debug.launchInspectApp', { announce: false });
  if (!liveSessionManager.isActive()) return undefined;
  return (await confirmAndRemember(liveSessionManager, confirmedReadySessions)) ? 'launched-live-session' : undefined;
}

/** Run the readiness confirm; on success remember the session so follow-up
 *  messages don't re-ask. Sessions without an id yet (mid-probe) are confirmed
 *  but not remembered. */
async function confirmAndRemember(
  liveSessionManager: LiveSessionManager,
  confirmedReadySessions: Set<string>,
): Promise<boolean> {
  const ready = await confirmAppReady(liveSessionManager.activePort());
  if (!ready) return false;
  const sessionId = liveSessionManager.activeSessionId();
  if (sessionId) confirmedReadySessions.add(sessionId);
  return true;
}

async function confirmAppReady(port: number | undefined): Promise<boolean> {
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
      placeHolder: `Is the inspected app ready${portLabel}?`,
      ignoreFocusOut: true,
    },
  );

  if (!choice) return false;
  if (choice.value === 'continue') return true;

  const done = await vscode.window.showInformationMessage(
    `Log in or navigate the inspected app${portLabel}, then click Continue to start the QA Agent.`,
    { modal: false },
    'Continue',
    'Cancel',
  );
  return done === 'Continue';
}

/** A `/generate` command, or a bare TestRail case id / "test case" wording,
 *  signals testcase authoring; anything else gets the neutral inspect prompt. */
function looksLikeTestcaseRequest(command: string | undefined, prompt: string): boolean {
  if (command === 'generate') return true;
  return /\bC\d{2,}\b/i.test(prompt) || /\btest\s?case\b/i.test(prompt);
}

function buildQaAgentPrompt(
  command: string | undefined,
  rawPrompt: string,
  liveMode: LiveMode,
  port: number | undefined,
): string {
  const userPrompt = rawPrompt.trim();
  const portSuffix = port ? ` (CDP port ${port})` : '';
  const liveLine =
    liveMode === 'repo-only'
      ? 'Live Inspect Session: not active. Work repo-first; ask the QA to launch or attach inspection before any MCP/browser step.'
      : liveMode === 'attached-live-session'
        ? `Live Inspect Session: attached to an existing CDP port${portSuffix}. Use qa-debug-cdp for browser MCP when repo evidence is insufficient; do not relaunch or close the app.`
        : `Live Inspect Session: active${portSuffix}. Use qa-debug-cdp for browser MCP when repo evidence is insufficient.`;

  if (looksLikeTestcaseRequest(command, userPrompt)) {
    const mode = inferMode(userPrompt);
    const commandLine = command ? `/${command}` : '@qa-agent';
    return [
      'You are in the qa-automation agent. Task: generate or update a testcase — follow the test-script-orchestrator skill.',
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

  // General / inspection intent — do NOT steer toward testcase generation.
  if (userPrompt) {
    return [
      'You are in the qa-automation agent. Task: live inspection (no testcase required).',
      '',
      `User request: ${userPrompt}`,
      liveLine,
      '',
      'Inspect the live app through qa-debug-cdp (browser_*) and qa_pick_element. Verify any element pick via browser_snapshot + the data-qa-pick marker, then build locators in the consumer project\'s convention (see the identify-live skill).',
      'If this turns into generating a testcase, follow the test-script-orchestrator skill and read the TestRail case via the TestRail tool first.',
    ].join('\n');
  }

  if (liveMode === 'repo-only') {
    // No live app and no specific request — find out what the QA wants rather
    // than stalling, and offer the two real paths.
    return [
      'You are in the qa-automation agent. No Live Inspect Session is active and no task was given yet.',
      '',
      liveLine,
      '',
      'Ask the QA what they want to do: inspect a running app (offer to launch or attach a Live Inspect Session) or generate/update a testcase from a TestRail case.',
    ].join('\n');
  }

  // Bare @qa-agent with a live session up: orient the QA instead of stalling on
  // "what do you want to inspect?". Identify what is actually running on the
  // port, then hand back an explicit "ready to interact".
  return [
    `You are in the qa-automation agent. A Live Inspect Session is active${portSuffix} (qa-debug-cdp MCP: browser_*, qa_pick_element).`,
    '',
    'The QA started the session but has not named a target yet. Orient them first:',
    `1. Identify what is running${portSuffix}: use qa-debug-cdp — browser_tabs to list the open pages, then browser_snapshot on the active one — to read the page title(s), URL(s), and app type.`,
    '2. Report what you found in one short summary, then tell the QA the app is ready — they can ask you to inspect any element, pick a locator, or walk through a flow.',
    '3. Stop and wait for their instruction. Do NOT start writing a testcase unless they ask.',
    '',
    'When you inspect, verify any element pick via browser_snapshot + the data-qa-pick marker, then build locators in the consumer project\'s convention (see the identify-live skill).',
  ].join('\n');
}

function inferMode(text: string): string | undefined {
  const lower = text.toLowerCase();
  // Whole-token match only, so prose like "auto-save feature" can't silently
  // select Auto (the no-confirmation mode). A stray standalone "manual" still
  // matches, but a false Manual only adds confirmations — the safe direction.
  const tokens = lower.split(/\s+/).map((t) => t.replace(/[.,!?]+$/, ''));
  if (tokens.includes('manual') || lower.includes('review first') || lower.includes('ask before')) {
    return 'Manual';
  }
  if (tokens.includes('auto') || lower.includes('go ahead') || lower.includes('ทำให้เลย')) {
    return 'Auto';
  }
  return undefined;
}

async function openInQaAgent(prompt: string): Promise<boolean> {
  const attempts: Array<() => Thenable<unknown>> = [
    () =>
      vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
        query: prompt,
        isPartialQuery: false,
        mode: 'qa-automation',
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
