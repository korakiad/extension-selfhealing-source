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
 *  - qa-debug.launchInspectApp / .stopInspectApp — Live Inspect Session lifecycle
 *
 * Verdict commands removed (2026-05-31): qa-debug.giveUp / qa-debug.markPassed
 * are gone. A pause is a pure inspection hold; there is no pass/fail verdict to
 * commit. The QA re-runs from Test Explorer ▶ or ends the run with Stop.
 */

import * as vscode from 'vscode';

import type { PausePayload } from '@qa-debug/pause-store-types';

import {
  liveAppDisplayName,
  type LiveAppSpec,
  type LiveSessionStartOptions,
  type LiveSessionManager,
} from './live-session-manager.js';
import { probePorts } from './lm-tools/probe-ports.js';
import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';
import type { SessionManager } from './session-manager.js';

export interface CommandDeps {
  pauseStore: MementoPauseStore;
  sessionManager: SessionManager;
  liveSessionManager: LiveSessionManager;
  /** Per-workspace store for the last inline-chosen app (prefill on next launch). */
  workspaceState: vscode.Memento;
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
    // Live Inspect Session — launch the QA's own app for inspection (no pause).
    vscode.commands.registerCommand('qa-debug.launchInspectApp', (opts?: LiveSessionStartOptions) =>
      launchInspectAppCmd(deps, opts),
    ),
    vscode.commands.registerCommand('qa-debug.stopInspectApp', () => stopInspectAppCmd(deps)),
  );
}

// ---- Live Inspect Session ----

const LAST_INLINE_APP_KEY = 'qa-debug.lastInlineApp';

/**
 * Launch an app with a CDP debug port so the picker can inspect it WITHOUT a
 * failing test. No settings required: if `qaDebug.liveApps` is empty we ASK
 * inline (Web / Electron / OpenFin + the url/path). The extension owns the
 * launch — knowing it spawned the browser is what lets it flip the
 * `qa-debug.liveSession` gate with certainty (see LiveSessionManager).
 */
async function launchInspectAppCmd(
  deps: CommandDeps,
  opts: LiveSessionStartOptions = {},
): Promise<void> {
  const apps = vscode.workspace.getConfiguration('qaDebug').get<LiveAppSpec[]>('liveApps') ?? [];

  let spec: LiveAppSpec | undefined;
  if (apps.length === 1) {
    spec = apps[0];
  } else if (apps.length > 1) {
    const choice = await vscode.window.showQuickPick(
      apps.map((a) => ({ label: liveAppDisplayName(a), description: a.type, spec: a })),
      { placeHolder: 'Select an app to launch for inspection', ignoreFocusOut: true },
    );
    spec = choice?.spec;
  } else {
    // No config — ask inline so the QA never has to edit settings.
    spec = await promptInlineSpec(deps);
  }
  if (!spec) return;

  try {
    await deps.liveSessionManager.launch(spec, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendInfo(deps.channel, `[command] launchInspectApp failed: ${msg}`);
    void vscode.window.showErrorMessage(`QA Debug: failed to launch inspect app — ${msg}`);
  }
}

/**
 * Inline launch prompt (no settings): pick the kind, then the url (web) or the
 * executable path (electron/openfin). Pre-filled from the last inline launch in
 * this workspace, so repeat launches are one Enter.
 */
async function promptInlineSpec(deps: CommandDeps): Promise<LiveAppSpec | undefined> {
  const last = deps.workspaceState.get<LiveAppSpec>(LAST_INLINE_APP_KEY);

  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(globe) Web', detail: 'Open a URL in an auto-detected Chrome/Edge', value: 'web' as const },
      { label: '$(window) Electron', detail: 'Launch an Electron app executable', value: 'electron' as const },
      { label: '$(window) OpenFin', detail: 'Launch an OpenFin app executable', value: 'openfin' as const },
    ],
    { placeHolder: 'What do you want to inspect?', ignoreFocusOut: true },
  );
  if (!kind) return undefined;
  const type = kind.value;

  let spec: LiveAppSpec | undefined;
  if (type === 'web') {
    const url = await vscode.window.showInputBox({
      prompt: 'URL to open for inspection',
      placeHolder: 'https://localhost:3000',
      // Prefill the last web URL, else a sensible default so the QA can just hit Enter.
      value: (last?.type === 'web' ? last.url : undefined) ?? 'https://www.google.com',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Enter a URL.'),
    });
    if (!url) return undefined;
    spec = { type: 'web', url: url.trim() };
  } else {
    const binary = await vscode.window.showInputBox({
      prompt: `Path to the ${type === 'openfin' ? 'OpenFin' : 'Electron'} app executable`,
      placeHolder: type === 'openfin' ? '/Applications/MyApp/MyApp' : '/path/to/app',
      value: last?.type === type ? last.binary : undefined,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Enter the executable path.'),
    });
    if (!binary) return undefined;
    spec = { type, binary: binary.trim() };
  }

  await deps.workspaceState.update(LAST_INLINE_APP_KEY, spec);
  return spec;
}

async function stopInspectAppCmd(deps: CommandDeps): Promise<void> {
  if (!deps.liveSessionManager.isActive()) {
    void vscode.window.showInformationMessage('QA Debug: no Live Inspect Session is active.');
    return;
  }
  await deps.liveSessionManager.stop();
  appendInfo(deps.channel, '[command] stopInspectApp invoked');
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
