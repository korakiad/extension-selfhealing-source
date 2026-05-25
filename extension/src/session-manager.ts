/**
 * SessionManager — owns the mocha child + Chrome lifecycle and routes IPC
 * traffic between hook (`qa-hooks.ts`) and extension state (PauseStore +
 * DecisionRouter + TestController + MCP provider).
 *
 * S4_DESIGN.md §6, §10, §11.
 * v5.2 alignment: injects `--require` + `--reporter` as absolute paths
 * resolved via `createRequire(__filename)` from the extension's location
 * (CR §2.1 [R#3-NB2 + R#3-NB6]). User's `.mocharc.cjs` needs zero edits.
 * CWD selection per CR §2.1 NB6: spec-URI-derived when invoked from
 * TestController; falls back to `<workspaceRoot>/fixture-tests` (demo) or
 * `<workspaceRoot>` for run-all.
 *
 * Suite-run sequence:
 *   1. runFixtureSuite() called via qa-debug.runFixture command or
 *      TestController run handler.
 *   2. Chrome.spawn() (idempotent — reuse across tests).
 *   3. controller.beginRun() returns a TestRunHandle scoped to this invocation.
 *   4. spawn mocha child with stdio[3]='ipc' + injected --require qa-hooks +
 *      --reporter qa-reporter (both absolute paths to bundled extension files).
 *   5. Construct JsonRpcConnection on the child. Register handlers.
 *   6. Wait for child exit. On clean exit with no outstanding pause, tear down
 *      Chrome. On exit with outstanding pause, leave Chrome up (per §6.3).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as vscode from 'vscode';

import {
  DecisionAwaitParams,
  FinalDecisionParams,
  JsonRpcConnection,
  METHOD,
  PausePayload as WirePausePayload,
  PausePublishResult,
  nodeIpcTransport,
} from '@qa-debug/mocha-hooks/protocol';
import type { PausePayload } from '@qa-debug/pause-store-types';

import type { ChromeProcess } from './chrome.js';
import type { DecisionRouter } from './decision-router.js';
import type { QaDebugMcpProvider } from './mcp-provider.js';
import { appendInfo } from './output-channel.js';
import type { PauseStatusBar } from './pause-status-bar.js';
import type { MementoPauseStore } from './pause-store.js';
import type { TestControllerWrapper, TestRunHandle } from './test-controller.js';

// CR-v5.6 §3.8 / I2#A — v5.5 unified-id formula `file::it::full_title`. Must
// match test-controller's lookupOrCreateTestItem so the context-key array set
// here intersects with the testId VS Code passes through testing/item/context.
function computeTestItemId(pause: PausePayload): string {
  return `${vscode.Uri.file(pause.file).toString()}::it::${pause.full_title}`;
}

async function refreshPausedTestIdsContext(pauseStore: MementoPauseStore): Promise<void> {
  const active = pauseStore.peekActivePause();
  const ids = active ? [computeTestItemId(active)] : [];
  await vscode.commands.executeCommand('setContext', 'qa-debug.pausedTestIds', ids);
}

const HEARTBEAT_MS = Number(process.env.QA_DEBUG_HEARTBEAT_MS ?? 5_000);

// v5.2 §2.1: absolute-path resolution for bundled hook + reporter. Resolved
// once at module load from the extension's own location via createRequire.
// fs.existsSync guard catches VSIX-misdeploy at extension activation (clearer
// than failing inside mocha child later). Per CR §5 VSIX-packaging risk row.
const extReq = createRequire(__filename);
const REGISTER_PATH: string = extReq.resolve('@qa-debug/mocha-hooks/register');
const REPORTER_PATH: string = extReq.resolve('@qa-debug/mocha-hooks/qa-reporter');
for (const [label, p] of [
  ['register', REGISTER_PATH] as const,
  ['reporter', REPORTER_PATH] as const,
]) {
  if (!existsSync(p)) {
    throw new Error(
      `qa-debug-companion bundled hook ${label} not found at ${p}. ` +
        `Likely VSIX was built without including @qa-debug/mocha-hooks workspace dist. ` +
        `See ARCHITECTURE-CR-v5.2 §5 risk row "VSIX packaging discipline".`,
    );
  }
}

export interface SessionManagerDeps {
  pauseStore: MementoPauseStore;
  decisionRouter: DecisionRouter;
  chrome: ChromeProcess;
  mcpProvider: QaDebugMcpProvider;
  testControllerWrapper: TestControllerWrapper;
  channel: vscode.OutputChannel;
  /** Workspace root used to resolve mocha bin + fallback CWD. */
  workspaceRoot: string;
  /**
   * Retained from v5.3 deps shape per ARCHITECTURE-CR-v5.4 §2.1; no longer
   * read by the notification handler (v5.4 dropped the "Ask Copilot" button).
   * Probed at activation for future re-use by other engagement paths.
   */
  chatOpenAvailable: boolean;
  chatOpenFallbackAvailable: boolean;
  /** v5.4 §2.2 — ambient pause indicator; show on pause-publish, hide on decision commit. */
  pauseStatusBar: PauseStatusBar;
}

interface ActiveRun {
  testHandle: TestRunHandle;
  child: ChildProcess;
  connection: JsonRpcConnection;
  heartbeatTimers: Map<string, NodeJS.Timeout>;
  /** session_ids whose decision.await is currently pending. */
  pendingSessions: Set<string>;
  /** CWD this run was spawned with. */
  cwd: string;
  /** Mocha bin used. */
  mochaBin: string;
}

export interface RunFixtureSuiteOptions {
  /**
   * Spec file URIs to run. If non-empty, CWD is derived from path.dirname
   * of the first URI's fsPath (per CR §2.1 NB6 recommended default).
   * If empty/undefined, CWD falls back to `<workspaceRoot>/fixture-tests`
   * (legacy demo flow) or `<workspaceRoot>` (generic run-all).
   */
  specs?: readonly vscode.Uri[];
  /** Test-run label surfaced in Test Explorer. */
  runLabel?: string;
  /**
   * v5.5 §2.5 — anchored alternation grep synthesized by TestController
   * planRun (NB13 mandatory alternation parens block the /pat/flags shortcut).
   * Forwarded to mocha as `--grep <value>`.
   */
  grep?: string;
  /**
   * v5.5 C2 — wired to `child.kill('SIGTERM')` on cancellation. The
   * heartbeat-abandon path in qa-hooks resolves the IPC decision so the
   * child exits cleanly.
   */
  cancellationToken?: vscode.CancellationToken;
}

export class SessionManager {
  private activeRun?: ActiveRun;
  private readonly chromeEventSubscriptions: { dispose(): void }[] = [];

  constructor(private readonly deps: SessionManagerDeps) {
    // v5.16 PLAN-cdp-port-discovery §3.18 — gate mcpProvider.setPaused on
    // chrome selection events. Two paths feed this funnel: agent via
    // qa-debug_qa_select_chrome (LM tool) and extension UI via QuickPick /
    // InputBox. Both write through PauseStore.recordChromeSelection which
    // awaits persistence before firing onChromeSelected.
    this.chromeEventSubscriptions.push(
      this.deps.pauseStore.onChromeSelected((selection) => {
        const httpRoot = cdpWsUrlToHttpRoot(selection.cdp_ws_url);
        this.deps.mcpProvider.setPaused(httpRoot);
        appendInfo(
          this.deps.channel,
          `[session-manager] mcpProvider.setPaused endpoint=${httpRoot} port=${selection.port} ` +
            `source=${selection.source} session=${selection.session_id}`,
        );
      }),
      this.deps.pauseStore.onChromeDeselected((sessionId) => {
        this.deps.mcpProvider.clearPaused();
        appendInfo(
          this.deps.channel,
          `[session-manager] mcpProvider.clearPaused (selection invalidated by ` +
            `replaceAvailableChromes) session=${sessionId}`,
        );
      }),
    );
  }

  /** Entrypoint for qa-debug.runFixture + TestController run handler. */
  async runFixtureSuite(opts: RunFixtureSuiteOptions = {}): Promise<void> {
    if (this.activeRun) {
      void vscode.window.showWarningMessage(
        'QA Debug: a suite run is already in progress.',
      );
      return;
    }
    await this.deps.chrome.spawn();
    const cwd = this.resolveCwd(opts.specs);
    const mochaBin = this.resolveMochaBin(cwd);
    const specFiles = (opts.specs ?? []).map((u) => u.fsPath);
    const testHandle = this.deps.testControllerWrapper.beginRun(
      opts.runLabel ?? (specFiles.length === 1 ? path.basename(specFiles[0]) : 'fixture suite'),
    );
    await this.spawnMochaChild(testHandle, {
      cwd,
      mochaBin,
      specFiles,
      grep: opts.grep,
      cancellationToken: opts.cancellationToken,
    });
  }

  /** Tear down everything; called from extension deactivate. */
  async dispose(): Promise<void> {
    if (this.activeRun) {
      try {
        this.activeRun.child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      this.activeRun = undefined;
    }
    for (const sub of this.chromeEventSubscriptions) {
      sub.dispose();
    }
    this.chromeEventSubscriptions.length = 0;
    await this.deps.chrome.dispose();
  }

  // ------------------- internal -------------------

  private async spawnMochaChild(
    testHandle: TestRunHandle,
    opts: {
      cwd: string;
      mochaBin: string;
      grep?: string;
      specFiles?: string[];
      cancellationToken?: vscode.CancellationToken;
    },
  ): Promise<void> {
    // v5.2 §2.1: inject --require + --reporter as absolute paths to the
    // extension-bundled hook/reporter. User .mocharc.cjs needs no edits.
    const args: string[] = [
      '--require',
      REGISTER_PATH,
      '--reporter',
      REPORTER_PATH,
    ];
    if (opts.grep) {
      args.push('--grep', opts.grep);
    }
    if (opts.specFiles && opts.specFiles.length > 0) {
      args.push(...opts.specFiles);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      QA_DEBUG_CDP_WS_URL: this.deps.chrome.cdpWsEndpoint,
    };

    appendInfo(
      this.deps.channel,
      `[session-manager] spawn mocha cwd=${opts.cwd} args=${JSON.stringify(args)}`,
    );
    const child = spawn(opts.mochaBin, args, {
      cwd: opts.cwd,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env,
    });

    // v5.5 C2 — Test Explorer Cancel button reaches the mocha child via SIGTERM.
    // The heartbeat-abandon path in qa-hooks resolves any open decision so the
    // child exits cleanly; per §4.5 test #5 the exit log lands before the next
    // heartbeat would have fired.
    opts.cancellationToken?.onCancellationRequested(() => {
      appendInfo(
        this.deps.channel,
        `[session-manager] cancellation requested; SIGTERM mocha pid=${child.pid}`,
      );
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    });

    const connection = new JsonRpcConnection(nodeIpcTransport(child));
    const run: ActiveRun = {
      testHandle,
      child,
      connection,
      heartbeatTimers: new Map(),
      pendingSessions: new Set(),
      cwd: opts.cwd,
      mochaBin: opts.mochaBin,
    };
    this.activeRun = run;

    this.wireConnection(run);

    child.on('exit', (code, signal) => {
      appendInfo(
        this.deps.channel,
        `[session-manager] mocha exited code=${code} signal=${signal}`,
      );
      this.onMochaExit(run);
    });
    child.on('error', (err) => {
      appendInfo(this.deps.channel, `[session-manager] mocha spawn error: ${err.message}`);
      void vscode.window.showErrorMessage(`QA Debug: mocha spawn error — ${err.message}`);
    });
  }

  private wireConnection(run: ActiveRun): void {
    const { connection } = run;

    connection.handle(METHOD.pausePublish, async (raw) => {
      const wire = WirePausePayload.parse(raw);
      const sessionId = `s4-${randomUUID()}`;
      const stored = wireToStored(wire, sessionId);
      await this.deps.pauseStore.setActivePause(stored);
      await vscode.commands.executeCommand('setContext', 'qa-debug.paused', true);
      await refreshPausedTestIdsContext(this.deps.pauseStore);
      // v5.16 PLAN-cdp-port-discovery §3.18 — mcpProvider.setPaused is gated
      // on a committed chrome selection. Don't fire here. Auto-select when
      // exactly one chrome was discovered; otherwise wait for agent
      // (qa_select_chrome / qa_discover_chromes) or extension UI to commit.
      const chromes = stored.available_chromes ?? [];
      appendInfo(
        this.deps.channel,
        `[session-manager] pause session=${sessionId} test="${stored.test_title}" ` +
          `chrome_owner=${stored.chrome_owner ?? 'unknown'} available_chromes=${chromes.length}`,
      );
      if (chromes.length === 1) {
        try {
          await this.deps.pauseStore.recordChromeSelection(sessionId, chromes[0].port, 'auto');
          appendInfo(
            this.deps.channel,
            `[session-manager] auto-selected single chrome port=${chromes[0].port} session=${sessionId}`,
          );
        } catch (err) {
          appendInfo(
            this.deps.channel,
            `[session-manager] auto-select failed session=${sessionId}: ${(err as Error).message}`,
          );
          // Pause still surfaces; user can recover via Select Chrome status-bar action.
        }
      } else if (chromes.length === 0) {
        appendInfo(
          this.deps.channel,
          `[session-manager] no chromes discovered — awaiting agent qa_discover_chromes ` +
            `or extension UI port input session=${sessionId}`,
        );
      } else {
        appendInfo(
          this.deps.channel,
          `[session-manager] multiple chromes discovered (${chromes.length}) — awaiting ` +
            `selection via agent qa_select_chrome or status-bar QuickPick session=${sessionId}`,
        );
      }
      run.testHandle.recordPause(stored);
      // v5.4 §2.2 — ambient status-bar entry augments the notification toast.
      this.deps.pauseStatusBar.show(sessionId);

      // v5.4 §2.1 — two-button notification (Ask Copilot removed); body text
      // names Agent-mode + Test Explorer as the two engagement paths.
      void vscode.window.showInformationMessage(
        `QA Debug: test "${stored.test_title}" failed at ${path.basename(stored.file)}:${stored.line ?? '?'}. ` +
          `Browser held — investigate via Copilot Agent mode (qa-debug tools auto-invoke) ` +
          `or pick a follow-up in Test Explorer.`,
        'Open Test Explorer',
        'Open Audit Log',
      ).then((sel) => {
        if (sel === 'Open Audit Log') {
          this.deps.channel.show();
        } else if (sel === 'Open Test Explorer') {
          void vscode.commands.executeCommand('workbench.view.testing.focus');
        }
      });

      const result: PausePublishResult = { session_id: sessionId };
      return result;
    });

    connection.handle(METHOD.decisionAwait, (raw) => {
      const params = DecisionAwaitParams.parse(raw);
      run.pendingSessions.add(params.session_id);
      return new Promise((resolve) => {
        this.deps.decisionRouter.enroll(params.session_id, (decision) => {
          this.stopHeartbeats(run, params.session_id);
          run.pendingSessions.delete(params.session_id);
          // v5.4 §4.5 test #2 — entry hides within 500ms of commit; the
          // decision-router callback fires at the UI button press, ahead of
          // qa-hooks' final_decision round-trip.
          this.deps.pauseStatusBar.hide(params.session_id);
          resolve(decision);
        });
        this.startHeartbeats(run, params.session_id, params.heartbeat_ms);
      });
    });

    connection.onNotification(METHOD.finalDecision, async (raw) => {
      const decision = FinalDecisionParams.parse(raw);
      const pause = this.peekPauseForFinalDecision(decision);
      run.testHandle.recordDecision(decision, pause);

      await this.deps.pauseStore.clearActivePause();
      await vscode.commands.executeCommand('setContext', 'qa-debug.paused', false);
      await refreshPausedTestIdsContext(this.deps.pauseStore);
      this.deps.mcpProvider.setIdle();
    });
  }

  private peekPauseForFinalDecision(decision: FinalDecisionParams): PausePayload | undefined {
    try {
      return this.deps.pauseStore.getActivePause(decision.session_id);
    } catch {
      return undefined;
    }
  }

  private startHeartbeats(run: ActiveRun, sessionId: string, intervalMs: number): void {
    const timer = setInterval(() => {
      run.connection.notify(METHOD.heartbeat, { session_id: sessionId, at: Date.now() });
    }, intervalMs);
    run.heartbeatTimers.set(sessionId, timer);
  }

  private stopHeartbeats(run: ActiveRun, sessionId: string): void {
    const timer = run.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      run.heartbeatTimers.delete(sessionId);
    }
  }

  private async onMochaExit(run: ActiveRun): Promise<void> {
    for (const sessionId of run.pendingSessions) {
      this.deps.decisionRouter.abandon(
        sessionId,
        'mocha child exited unexpectedly (no final_decision)',
        'hook',
      );
    }
    for (const timer of run.heartbeatTimers.values()) clearInterval(timer);
    run.heartbeatTimers.clear();
    run.pendingSessions.clear();

    if (this.activeRun === run) {
      this.activeRun = undefined;
    }

    const stalePause = this.deps.pauseStore.peekActivePause();
    if (!stalePause) {
      await this.deps.chrome.dispose();
    } else {
      appendInfo(
        this.deps.channel,
        `[session-manager] mocha exited with outstanding pause session=${stalePause.session_id}; ` +
          `Chrome stays up; next run reuses`,
      );
    }
    run.testHandle.end();
  }

  /**
   * CWD selection per CR §2.1 [R#3-NB6]:
   *  - If specs[] non-empty: parent dir of first spec (transparent for any
   *    user project layout — wdio or otherwise).
   *  - Else if `<workspaceRoot>/fixture-tests` exists: legacy demo flow.
   *  - Else: workspaceRoot (user's .mocharc.cjs from there decides spec patterns).
   */
  private resolveCwd(specs: readonly vscode.Uri[] | undefined): string {
    if (specs && specs.length > 0) {
      return path.dirname(specs[0].fsPath);
    }
    const fixtureDir = path.join(this.deps.workspaceRoot, 'fixture-tests');
    if (existsSync(fixtureDir)) {
      return fixtureDir;
    }
    return this.deps.workspaceRoot;
  }

  private resolveMochaBin(cwd: string): string {
    // Look in the chosen CWD's node_modules first, then walk up two levels
    // (works for typical monorepo layouts: cwd/node_modules, cwd/../node_modules,
    // cwd/../../node_modules), then workspaceRoot.
    const candidates = [
      path.join(cwd, 'node_modules', '.bin', 'mocha'),
      path.join(cwd, '..', 'node_modules', '.bin', 'mocha'),
      path.join(cwd, '..', '..', 'node_modules', '.bin', 'mocha'),
      path.join(this.deps.workspaceRoot, 'node_modules', '.bin', 'mocha'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error(
      `Could not find mocha binary near ${cwd} or ${this.deps.workspaceRoot}. ` +
        `Did the user's project install mocha?`,
    );
  }
}

/**
 * Convert a CDP WebSocket URL (`ws://host:port` or `ws://host:port/devtools/browser/<UUID>`)
 * to the HTTP root form (`http://host:port`) that `mcpProvider.setPaused` expects.
 *
 * Playwright `connectOverCDP` accepts BOTH ws-with-path and http-root forms
 * (class-browsertype.md), but canonicalizing to http-root keeps the wire-bound
 * value aligned with `chrome.cdpHttpEndpoint` (chrome.ts:138) — single shape
 * across Mode A (wire-discovered random/locked port) and Mode B (extension's
 * own 9222 chrome). http-root also lets Playwright re-discover the active
 * target via `/json/version` if the devtools UUID rotates between discovery
 * and connect.
 *
 * Assumes the input uses `ws://` scheme (validated by `PausePayload.cdp_ws_url`
 * zod schema in mocha-hooks/protocol.ts). If remote-chrome `wss://` support is
 * ever added, preserve scheme via `wsUrl.startsWith('wss:') ? 'https' : 'http'`.
 */
function cdpWsUrlToHttpRoot(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `http://${u.host}`;
}

function wireToStored(wire: WirePausePayload, sessionId: string): PausePayload {
  const stackFrames = (wire.error.stack ?? '').split('\n').slice(1).map((s) => s.trimStart());
  return {
    session_id: sessionId,
    test_title: wire.test,
    // v5.5 §2.4 — pass the canonical full title through to the store so
    // TestController.recordPause can look up the discovery TestItem by unified id.
    full_title: wire.full_title,
    file: wire.file ?? '<unknown>',
    line: wire.line ?? undefined,
    failing_assertion: wire.error.message,
    stack_trace: { frames: stackFrames },
    cdp_ws_url: wire.cdp_ws_url,
    mode: wire.mode, // v5.2 §2.4 — legacy field; kept transitional, see pause-store-types ChromeOwner
    // v5.16 — propagate Mode C discovery fields to store for agent + UI consumers.
    available_chromes: wire.available_chromes ?? [],
    selected_cdp_port: wire.selected_cdp_port ?? null,
    chrome_owner: wire.chrome_owner ?? (wire.mode === 'A' ? 'framework' : 'companion'),
    console_logs: { lines: [], bytes: 0 },
    paused_at_ms: wire.started_at,
    retry_count: wire.retry_count,
    max_retries_remaining: 0,
  };
}

void HEARTBEAT_MS;
