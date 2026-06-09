/**
 * qa-debug.* commands per `extension/package.json contributes.commands`:
 *  - qa-debug.runFixture          — spawn the fixture suite (entry point)
 *  - qa-debug.cancelRun           — interrupt the active run's whole process
 *                                   group (mocha + launched browser), Ctrl-C
 *                                   style; recover from a wrong-fixture pick
 *                                   mid-run AND the way to end an inspection
 *                                   pause (the test stands at its Mocha outcome)
 *  - qa-debug.openChatForPaused   — open Copilot Chat with a prefilled prompt
 *                                   describing the pause
 *  - qa-debug.selectChrome / .enterChromePorts — Mode C chrome selection
 *
 * Verdict commands removed (2026-05-31): qa-debug.giveUp / qa-debug.markPassed
 * are gone. A pause is a pure inspection hold; there is no pass/fail verdict to
 * commit. The QA re-runs from Test Explorer ▶ or ends the run with Stop.
 */

import * as vscode from 'vscode';

import type { PausePayload } from '@qa-debug/pause-store-types';

import { probePorts } from './lm-tools/probe-ports.js';
import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';
import type { SessionManager } from './session-manager.js';

export interface CommandDeps {
  pauseStore: MementoPauseStore;
  sessionManager: SessionManager;
  channel: vscode.OutputChannel;
}

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
let chatOpenAvailableCache: boolean | undefined;

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.runFixture', () => runFixtureCmd(deps)),
    vscode.commands.registerCommand('qa-debug.cancelRun', () => cancelRunCmd(deps)),
    vscode.commands.registerCommand('qa-debug.openChatForPaused', () => openChatForPausedCmd(deps)),
    // v5.16 — status-bar surfaces these when available_chromes.length !== 1
    // (no auto-select happened).
    vscode.commands.registerCommand('qa-debug.selectChrome', () => selectChromeCmd(deps)),
    vscode.commands.registerCommand('qa-debug.enterChromePorts', () => enterChromePortsCmd(deps)),
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

/**
 * Recover from a wrong-fixture selection without waiting for mocha to fail.
 * Modal confirm because the cancel aborts every test in the current run.
 */
async function cancelRunCmd(deps: CommandDeps): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Cancel the running fixture suite? Any unfinished tests will be aborted.',
    { modal: true },
    'Cancel Suite',
  );
  if (choice !== 'Cancel Suite') return;
  const cancelled = deps.sessionManager.cancelActiveRun('user invoked qa-debug.cancelRun');
  if (!cancelled) {
    void vscode.window.showInformationMessage('QA Debug: no active suite run to cancel.');
    return;
  }
  appendInfo(deps.channel, '[command] cancelRun invoked');
}

/**
 * Open Copilot Chat with a deterministic prefilled prompt describing the active
 * pause. Feature-detects `workbench.action.chat.open`; falls back to clipboard
 * + chat-view-focus when unavailable.
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
    // iter#1 manual-QA fix 2026-05-22:
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
      // Switch into our contributed `qa-debug` custom agent (agents/qa-debug.agent.md),
      // whose `tools:` allowlist scopes the session to qa-debug-cdp + our verbs and
      // EXCLUDES any other browser/playwright server from the request — fewer tool
      // schemas in context (token saving) + no mis-pick. The agent is gated on
      // `when: qa-debug.paused`, which is set before this runs. If it can't resolve
      // (agent unavailable), chat.open no-ops the switch and stays in the current
      // mode — a benign fallback.
      mode: 'qa-debug',
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
  // The investigation workflow (Step 0 A/B branch, chrome discovery/selection,
  // live-browser ground-truth, playwright-mcp visibility check, propose-don't-edit,
  // pure-inspection-hold) lives ONCE in skills/qa-debug/SKILL.md and loads via
  // progressive disclosure when this prompt matches the skill's description. This
  // prompt carries only the per-pause data + an explicit skill invocation, so the
  // workflow has a single source of truth and can't drift against the skill.
  const chromes = pause.available_chromes ?? [];
  const selectedPort = pause.selected_cdp_port ?? null;
  const selected = selectedPort != null ? chromes.find((c) => c.port === selectedPort) : undefined;

  let chromeLine: string;
  if (selected) {
    chromeLine = `Browser: chrome already selected at port ${selected.port} (cdp_ws_url=${selected.ws_url}).`;
  } else if (chromes.length === 1) {
    chromeLine = `Browser: 1 chrome discovered (port ${chromes[0].port}); no selection committed yet.`;
  } else if (chromes.length >= 2) {
    const summary = chromes
      .map(
        (c) =>
          `port ${c.port}${c.page_titles.length > 0 ? ` (${c.page_titles.slice(0, 2).join(' / ')})` : ''}`,
      )
      .join('; ');
    chromeLine = `Browser: ${chromes.length} chromes discovered — ${summary}; no selection committed.`;
  } else {
    chromeLine = 'Browser: no chromes discovered at the default debug ports.';
  }

  return [
    'A Mocha test just paused at a failure. Engage the qa-debug skill and run its Step 0 first.',
    '',
    `Test: ${pause.full_title}`,
    `File: ${pause.file}:${pause.line ?? '?'}`,
    `Failure: ${pause.failing_assertion}`,
    chromeLine,
  ].join('\n');
}

async function isChatOpenAvailable(): Promise<boolean> {
  if (chatOpenAvailableCache !== undefined) return chatOpenAvailableCache;
  const all = await vscode.commands.getCommands(true);
  chatOpenAvailableCache = all.includes(CHAT_OPEN_COMMAND);
  return chatOpenAvailableCache;
}

// ---- v5.16 — extension UI chrome selection ----

async function selectChromeCmd(deps: CommandDeps): Promise<void> {
  let active: PausePayload;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }
  const chromes = active.available_chromes ?? [];
  if (chromes.length === 0) {
    void vscode.window.showInformationMessage(
      'QA Debug: no Chrome discovered yet — use "Enter Chrome ports" to supply ports.',
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    chromes.map((c) => ({
      label: `Port ${c.port}`,
      detail: c.page_titles.length > 0 ? c.page_titles.join(' / ') : '(no page titles)',
      port: c.port,
    })),
    { placeHolder: 'Select the Chrome to attach playwright-mcp to', ignoreFocusOut: true },
  );
  if (!pick) return;
  try {
    await deps.pauseStore.recordChromeSelection(active.session_id, pick.port, 'extension-ui');
    appendInfo(deps.channel, `[command] selectChrome committed port=${pick.port}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendInfo(deps.channel, `[command] selectChrome failed: ${msg}`);
    void vscode.window.showErrorMessage(`QA Debug: chrome selection failed — ${msg}`);
  }
}

async function enterChromePortsCmd(deps: CommandDeps): Promise<void> {
  let active: PausePayload;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Chrome debug ports (comma-separated)',
    placeHolder: '22135, 22136',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const tokens = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (tokens.length === 0) return 'Enter at least one port (1024-65535).';
      if (tokens.length > 8) return 'At most 8 ports.';
      for (const t of tokens) {
        const n = Number(t);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
          return `"${t}" is not a valid port (1024-65535).`;
        }
      }
      return null;
    },
  });
  if (!input) return;
  const ports = input
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  try {
    const chromes = await probePorts(ports);
    if (chromes.length === 0) {
      void vscode.window.showErrorMessage(
        `QA Debug: none of the supplied ports [${ports.join(', ')}] responded. ` +
          'Verify the framework launched Chrome on those ports.',
      );
      return;
    }
    await deps.pauseStore.replaceAvailableChromes(active.session_id, chromes);
    appendInfo(
      deps.channel,
      `[command] enterChromePorts found ${chromes.length} chrome(s) at [${chromes.map((c) => c.port).join(', ')}]`,
    );
    // If exactly one responded, auto-select for UX symmetry with pause-publish.
    if (chromes.length === 1) {
      await deps.pauseStore.recordChromeSelection(active.session_id, chromes[0].port, 'extension-ui');
    } else {
      // Surface the QuickPick immediately so the user lands on selection in one flow.
      await selectChromeCmd(deps);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendInfo(deps.channel, `[command] enterChromePorts failed: ${msg}`);
    void vscode.window.showErrorMessage(`QA Debug: ${msg}`);
  }
}
