/**
 * qa-debug.* commands per `extension/package.json contributes.commands`:
 *  - qa-debug.runFixture          — spawn the fixture suite (entry point)
 *  - qa-debug.cancelRun           — interrupt the active run's whole process
 *                                   group (mocha + launched browser), Ctrl-C
 *                                   style; recover from a wrong-fixture pick
 *                                   mid-run AND the way to end an inspection
 *                                   pause (the test stands at its Mocha outcome)
 *  - qa-debug.openChatForPaused   — open Copilot Chat with a prefilled prompt
 *                                   describing the pause (CR-v5.6 §2.2 / §3.8.1)
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
    // v5.16 PLAN-cdp-port-discovery §3.14 — status-bar surfaces these when
    // available_chromes.length !== 1 (no auto-select happened).
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
 * CR-v5.6 §3.8.1 — open Copilot Chat with a deterministic prefilled prompt
 * describing the active pause. Feature-detects `workbench.action.chat.open`;
 * falls back to clipboard + chat-view-focus when unavailable.
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
    // CR-v5.6 §2.2 / iter#1 manual-QA fix 2026-05-22:
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
      mode: 'agent',
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
  // v5.16 PLAN-cdp-port-discovery — cdp_ws_url is derived after a chrome
  // selection commits; it is null until then. The prompt no longer inlines a
  // (possibly stale) endpoint and instead tells the agent how to land on a
  // dialable one via the new discover/select tools.
  const chromes = pause.available_chromes ?? [];
  const selectedPort = pause.selected_cdp_port ?? null;
  const selected = selectedPort != null ? chromes.find((c) => c.port === selectedPort) : undefined;

  let chromeLine: string;
  let nextStep: string;
  if (selected) {
    chromeLine = `Browser: chrome already selected at port ${selected.port} (cdp_ws_url=${selected.ws_url}).`;
    nextStep =
      'Call qa-debug_qa_get_failure_context to ground. playwright-mcp is already registered against the held browser — start inspecting with browser_snapshot (there is no attach step and no cdp_ws_url to pass anywhere). ' +
      'The browser it drives is the same Chrome the failing test was driving — DOM, console, network state are live.';
  } else if (chromes.length === 1) {
    chromeLine = `Browser: 1 chrome discovered (port ${chromes[0].port}); no selection committed yet.`;
    nextStep =
      `Call qa-debug_qa_get_failure_context first to ground, then qa-debug_qa_select_chrome with session_id and port=${chromes[0].port} ` +
      '(no user confirmation needed for a single candidate). Once selection commits, playwright-mcp is auto-registered against the held browser — start inspecting with browser_snapshot (no attach step).';
  } else if (chromes.length >= 2) {
    const summary = chromes
      .map(
        (c) =>
          `port ${c.port}${c.page_titles.length > 0 ? ` (${c.page_titles.slice(0, 2).join(' / ')})` : ''}`,
      )
      .join('; ');
    chromeLine = `Browser: ${chromes.length} chromes discovered — ${summary}; no selection committed.`;
    nextStep =
      'Call qa-debug_qa_get_failure_context first to ground. Then ask the user which chrome to inspect (surface page_titles as context). ' +
      'Once they pick, call qa-debug_qa_select_chrome with their port. After it commits, playwright-mcp is auto-registered against the held browser — start inspecting with browser_snapshot (no attach step).';
  } else {
    chromeLine = 'Browser: no chromes discovered at the default debug ports.';
    nextStep =
      "Call qa-debug_qa_get_failure_context first to ground. Then ask the user: \"I couldn't find Chrome at the default debug ports — what port(s) does your test framework launch Chrome on?\" " +
      'Call qa-debug_qa_discover_chromes(session_id, [user-ports]); if it returns chromes, call qa-debug_qa_select_chrome next; once it commits, playwright-mcp is auto-registered against the held browser — start inspecting with browser_snapshot.';
  }

  return [
    'A Mocha test is paused at the failure point. Investigate using the qa-debug + playwright-mcp tools.',
    '',
    `Test: ${pause.full_title}`,
    `File: ${pause.file}:${pause.line ?? '?'}`,
    `Failure: ${pause.failing_assertion}`,
    chromeLine,
    '',
    'Step 0 — Ask ONE short question up front, then branch on the answer. Present it as an interactive choice popup with exactly two ' +
      'SELECTABLE options the user clicks (a two-button / quick-pick popup is good here — use it). Do NOT ask an open-ended, free-text ' +
      '"how would you like me to proceed? / enter your answer" question — that is the wrong shape; the answer is always one of these two:',
    '  Option A — "Let me find the root cause for you": you\'re not sure why it failed — I\'ll investigate the held browser end-to-end, ' +
      'diagnose the cause, and come back with the fix.',
    '  Option B — "You already know the root cause": tell me what\'s wrong and the change you want, and I\'ll make the edit for you — ' +
      'no investigation needed.',
    'Then branch: pick A (or a vague "go ahead" / "you find it") → run the full Step 1 → Step 2 investigation. ' +
      'Pick B → skip the browser investigation; ground with Step 1 only if you need file/line context, then propose or apply the edit they describe. ' +
      'Skip the ask when their opening turn already decides it (they described the root cause → treat as B; they asked you to investigate → treat as A), ' +
      'or in autopilot / auto-approve mode (default to A).',
    '',
    'GROUND TRUTH IS THE LIVE BROWSER, NOT THE SOURCE FILES.',
    "Do NOT shortcut by reading the page's .html / .js / .css source to guess what's on screen. " +
      'The browser at the CDP endpoint above is the exact Chrome window the test was driving when it failed — ' +
      'post-JS DOM, computed styles, in-flight network responses, console errors, framework state, async timers, ' +
      'dynamically-injected nodes — none of which exist in the source files. Source can be stale, can be conditionally rendered, ' +
      'can be overridden at runtime. Inspect the live browser first (browser_snapshot); read source only to corroborate something you already observed live.',
    '',
    nextStep,
    '',
    'playwright-mcp is available in your registry. Find its child tools by the browser_* SUFFIX — the server may be registered ' +
      'under various prefixes (mcp_<server>_browser_*, com.microsoft/playwright-mcp/browser_*, mcp__<server>__browser_*); ' +
      'match on the browser_ suffix, not on prefix. ' +
      'There is no connect/attach tool — the extension already pointed playwright-mcp at the held browser when the chrome was selected; just call browser_snapshot to inspect it, ' +
      'then use the rest of the playwright-mcp surface — DOM, targeted in-page JS, screenshots, plus interactive tools when read-only can\'t disambiguate. Prefer read-only moves first.',
    'VERIFY playwright-mcp is visible before you investigate. Once the chrome selection has committed, confirm at least one browser_* tool ' +
      'actually appears in your tool registry (match on the browser_ suffix, any prefix). If NO browser_* tool is present, playwright-mcp is not ' +
      'running — do NOT silently fall back to reading source. Stop and tell the user: "I can\'t see the playwright-mcp browser tools, so I can\'t ' +
      'inspect the live browser. The extension launches playwright-mcp via `npx @playwright/mcp@latest`; please make sure MCP support is enabled in ' +
      'this editor and the playwright-mcp server is installed/trusted/started, then ask me to retry." Wait until they confirm it\'s available before continuing.',
    'Network and console reads are OFF-BY-DEFAULT in beta (noisy framework / HMR / dev-telemetry / hot-reload chatter drowns the signal). ' +
      'browser_network_requests and browser_console_messages (and browser_evaluate(console.*)-style log scrapes) are on-demand — ' +
      'call them only after the user explicitly asks ("show the console", "check the network", "any failed requests?"), ' +
      'OR after you asked them yourself ("Want me to pull network requests for an upstream check?") and they confirmed. ' +
      'For runtime-state queries, use browser_evaluate against a specific expression (window.__lastError, framework state) instead.',
    'Do NOT call browser_close or browser_navigate — both destroy the post-failure state the pause is preserving.',
    '',
    'Default: propose, don\'t edit. Surface file:line / tool-call shape in chat and wait for the user before applying ' +
      'any file edit or running state-changing playwright-mcp tools (anything that clicks, fills, navigates, presses keys). ' +
      'Skip the ask gate only if the session is in autopilot / auto-approve mode. ' +
      'Read-only investigation (DOM snapshot, targeted evaluate, screenshot) never needs the gate.',
    '',
    'This pause is a pure inspection hold — there is NO pass/fail verdict to commit and no decision verb to call. ' +
      'After investigating, propose any source/spec fix in chat (file:line + the change), then ASK explicitly: ' +
      '"Anything else you\'d like me to investigate or check before you re-run (pull network/console, check a sibling spec, ' +
      'add a defensive guard)?" Do not end the turn after the diff — the user often has follow-up steps. ' +
      'When they\'re done they re-run from Test Explorer ▶ (a fresh pause arrives if it still fails) or end the run with Stop. ' +
      'You never commit a result; the test stands at its natural Mocha outcome.',
  ].join('\n');
}

async function isChatOpenAvailable(): Promise<boolean> {
  if (chatOpenAvailableCache !== undefined) return chatOpenAvailableCache;
  const all = await vscode.commands.getCommands(true);
  chatOpenAvailableCache = all.includes(CHAT_OPEN_COMMAND);
  return chatOpenAvailableCache;
}

// ---- v5.16 PLAN-cdp-port-discovery — extension UI chrome selection ----

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
