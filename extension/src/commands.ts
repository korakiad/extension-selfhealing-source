/**
 * qa-debug.* commands per `extension/package.json contributes.commands`:
 *  - qa-debug.runFixture          — spawn the fixture suite (entry point)
 *  - qa-debug.giveUp              — commit give_up (reversible; no UI confirm)
 *  - qa-debug.markPassed          — commit mark_passed (irreversible; UI confirm
 *                                   for proposals, showInputBox prompt for cold clicks
 *                                   per S4_DESIGN §8.2 case 3 [R#3-B1c])
 *  - qa-debug.openChatForPaused   — open Copilot Chat with a prefilled prompt
 *                                   describing the pause (CR-v5.6 §2.2 / §3.8.1)
 */

import * as vscode from 'vscode';

import type { DecisionKind } from '@qa-debug/mocha-hooks/protocol';
import type { PausePayload } from '@qa-debug/pause-store-types';

import type { DecisionRouter } from './decision-router.js';
import { probePorts } from './lm-tools/probe-ports.js';
import { appendInfo } from './output-channel.js';
import type { MementoPauseStore } from './pause-store.js';
import type { SessionManager } from './session-manager.js';

export interface CommandDeps {
  pauseStore: MementoPauseStore;
  decisionRouter: DecisionRouter;
  sessionManager: SessionManager;
  channel: vscode.OutputChannel;
}

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
let chatOpenAvailableCache: boolean | undefined;

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.runFixture', () => runFixtureCmd(deps)),
    vscode.commands.registerCommand('qa-debug.giveUp', () => giveUpCmd(deps)),
    vscode.commands.registerCommand('qa-debug.markPassed', () => markPassedCmd(deps)),
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

/** give_up commits immediately through DecisionRouter. */
async function giveUpCmd(deps: CommandDeps): Promise<void> {
  let active;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }
  const reason = 'user clicked Give Up in Test Explorer';
  const ok = deps.decisionRouter.commit(active.session_id, 'give_up' as DecisionKind, reason, 'human');
  if (!ok) {
    void vscode.window.showErrorMessage('QA Debug: Pause already resolved.');
  }
}

/** Mark-passed: proposal-driven path or cold-click with showInputBox guard. */
async function markPassedCmd(deps: CommandDeps): Promise<void> {
  let active;
  try {
    active = deps.pauseStore.getActivePause()!;
  } catch {
    void vscode.window.showErrorMessage('QA Debug: no Mocha test is currently paused.');
    return;
  }

  const proposal = deps.pauseStore.pollProposal(active.session_id);
  let rationale: string;
  let by: 'human' | 'agent';

  if (proposal && proposal.kind === 'mark_passed') {
    // Proposal-driven: the agent already supplied the rationale; the human is
    // committing it. We still attribute `by: 'human'` because the commit was a
    // human click; the agent's role is captured in the proposal/rationale text.
    rationale = proposal.rationale;
    by = 'human';
  } else {
    // Cold click — prompt for a rationale. validateInput blocks OK-with-empty
    // per S4_DESIGN §8.2 case 3 [R#3-B1c]; Escape returns undefined.
    const input = await vscode.window.showInputBox({
      prompt: 'Why mark this test as passed?',
      placeHolder: 'Specific, falsifiable rationale — what makes this a real pass?',
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length === 0 ? 'Rationale required (be specific and falsifiable)' : null,
    });
    if (!input?.trim()) {
      // User cancelled (Escape) — leave the pause open. validateInput should
      // have prevented empty-OK, but belt-and-suspenders.
      return;
    }
    rationale = input.trim();
    by = 'human';
  }

  const ok = deps.decisionRouter.commit(active.session_id, 'mark_passed', rationale, by);
  if (!ok) {
    void vscode.window.showErrorMessage('QA Debug: Pause already resolved.');
  }
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
      'Call qa-debug_qa_get_failure_context to ground, then attach via the playwright-mcp browser_connect tool using the cdp_ws_url it returns. ' +
      'The browser at that endpoint is the same Chrome the failing test was driving — DOM, console, network state are live.';
  } else if (chromes.length === 1) {
    chromeLine = `Browser: 1 chrome discovered (port ${chromes[0].port}); no selection committed yet.`;
    nextStep =
      `Call qa-debug_qa_get_failure_context first to ground, then qa-debug_qa_select_chrome with session_id and port=${chromes[0].port} ` +
      '(no user confirmation needed for a single candidate). After selection commits, attach via the playwright-mcp browser_connect tool using the returned cdp_ws_url.';
  } else if (chromes.length >= 2) {
    const summary = chromes
      .map(
        (c) =>
          `port ${c.port}${c.page_titles.length > 0 ? ` (${c.page_titles.slice(0, 2).join(' / ')})` : ''}`,
      )
      .join('; ');
    chromeLine = `Browser: ${chromes.length} chromes discovered — ${summary}; no selection committed.`;
    nextStep =
      'Call qa-debug_qa_get_failure_context first to ground. Then ask the user which chrome to attach to (surface page_titles as context). ' +
      'Once they pick, call qa-debug_qa_select_chrome with their port. After it commits, attach via the playwright-mcp browser_connect tool using the returned cdp_ws_url.';
  } else {
    chromeLine = 'Browser: no chromes discovered at the default debug ports.';
    nextStep =
      "Call qa-debug_qa_get_failure_context first to ground. Then ask the user: \"I couldn't find Chrome at the default debug ports — what port(s) does your test framework launch Chrome on?\" " +
      'Call qa-debug_qa_discover_chromes(session_id, [user-ports]); if it returns chromes, call qa-debug_qa_select_chrome next; then attach via the playwright-mcp browser_connect tool.';
  }

  return [
    'A Mocha test is paused at the failure point. Investigate using the qa-debug + playwright-mcp tools.',
    '',
    `Test: ${pause.full_title}`,
    `File: ${pause.file}:${pause.line ?? '?'}`,
    `Failure: ${pause.failing_assertion}`,
    chromeLine,
    '',
    'Step 0 — Check with the user first. Before launching into investigation, ask once: ' +
      '"Want me to investigate end-to-end, or is there a specific angle you\'d like me to look at first ' +
      "(a suspect file / hypothesis / 'just check network' / 'just look at the DOM')?\" " +
      'Wait for their reply. Skip this ask if their opening turn already named an angle, or if the session is in autopilot / auto-approve mode.',
    '',
    'GROUND TRUTH IS THE LIVE BROWSER, NOT THE SOURCE FILES.',
    "Do NOT shortcut by reading the page's .html / .js / .css source to guess what's on screen. " +
      'The browser at the CDP endpoint above is the exact Chrome window the test was driving when it failed — ' +
      'post-JS DOM, computed styles, in-flight network responses, console errors, framework state, async timers, ' +
      'dynamically-injected nodes — none of which exist in the source files. Source can be stale, can be conditionally rendered, ' +
      'can be overridden at runtime. Attach first; read source only to corroborate something you already observed live.',
    '',
    nextStep,
    '',
    'playwright-mcp is available in your registry. Find its child tools by the browser_* SUFFIX — the server may be registered ' +
      'under various prefixes (mcp_<server>_browser_*, com.microsoft/playwright-mcp/browser_*, mcp__<server>__browser_*); ' +
      'match on the browser_ suffix, not on prefix. ' +
      'Use browser_connect with the cdp_ws_url to attach to the held browser, then use the rest of the playwright-mcp surface to inspect it — ' +
      'DOM, targeted in-page JS, screenshots, plus interactive tools when read-only can\'t disambiguate. Prefer read-only moves first.',
    'Network and console reads are OFF-BY-DEFAULT in beta (noisy framework / HMR / dev-telemetry / hot-reload chatter drowns the signal). ' +
      'browser_network_requests and browser_console_messages (and browser_evaluate(console.*)-style log scrapes) are on-demand — ' +
      'call them only after the user explicitly asks ("show the console", "check the network", "any failed requests?"), ' +
      'OR after you asked them yourself ("Want me to pull network requests for an upstream check?") and they confirmed. ' +
      'For runtime-state queries, use browser_evaluate against a specific expression (window.__lastError, framework state) instead.',
    'Do NOT call browser_close or browser_navigate — both destroy the post-failure state the pause is preserving.',
    '',
    'Default: propose, don\'t edit. Surface file:line / tool-call shape in chat and wait for the user before applying ' +
      'any file edit, running state-changing playwright-mcp tools (anything that clicks, fills, navigates, presses keys), ' +
      'or qa-debug_qa_propose_* / qa_request_* verbs. ' +
      'Skip the ask gate only if the session is in autopilot / auto-approve mode. ' +
      'Read-only investigation (DOM snapshot, targeted evaluate, screenshot) never needs the gate.',
    '',
    'Keep the loop open. After proposing a fix (code-bug / test-bug), ASK explicitly: "Anything else you\'d like me to investigate, ' +
      'add to the fix, or check before you re-run (e.g., pull network/console if you want them, check a sibling spec, ' +
      'add a defensive guard)?" Do not end the turn after the diff. The user often has follow-up steps — let them voice those ' +
      'before you stop. End the turn only when the user signals done or pivots.',
    'Two-stage commit for qa-debug verbs. Before calling qa-debug_qa_propose_mark_passed (env-flake), ' +
      'qa-debug_qa_propose_abort_suite (structural), or qa-debug_qa_request_give_up (ambiguous / out-of-scope), ' +
      'first surface your classification and ASK: "Leaning <verb> because <rationale>. Before I commit, anything else to investigate or pull?" ' +
      'Wait for the user. Only after they confirm do you call the verb and end the turn. ' +
      'Do NOT jump to give_up — it is the last reach, not the first. The pause + playwright-mcp loop stays hot for follow-up investigation.',
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
