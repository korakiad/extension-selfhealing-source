/**
 * SessionManager — owns the mocha task + Chrome lifecycle and routes IPC
 * traffic between hook (`qa-hooks.ts`) and extension state (PauseStore +
 * DecisionRouter + TestController + MCP provider).
 *
 * v5.2 alignment: injects `--require` + `--reporter` as absolute paths
 * resolved via `createRequire(__filename)` from the extension's location.
 * User's `.mocharc.cjs` needs zero edits. CWD selection: spec-URI-derived
 * when invoked from TestController; falls back to
 * `<workspaceRoot>/fixture-tests` (demo) or `<workspaceRoot>` for run-all.
 *
 * Suite-run sequence (v5.18 task-terminal mode):
 *   1. runFixtureSuite() called via qa-debug.runFixture command or
 *      TestController run handler.
 *   2. controller.beginRun() returns a TestRunHandle scoped to this invocation.
 *   3. Start a per-run IPC endpoint (named pipe / unix socket) the hook dials
 *      back to — the task terminal's process is the pty host's child, not
 *      ours, so the old stdio[3]='ipc' channel cannot exist.
 *   4. Execute a VS Code task (ProcessExecution: `node <mocha.js> --require
 *      qa-hooks --reporter qa-reporter ...`, argv array, no shell). The QA
 *      sees live mocha output in a real terminal and can Ctrl-C it.
 *   5. Construct JsonRpcConnection on the (queueing) endpoint transport.
 *      Register handlers.
 *   6. Wait for onDidEndTaskProcess. On clean exit with no outstanding pause,
 *      tear down. On exit with outstanding pause, synthesize give_up teardown.
 */

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
} from '@qa-debug/mocha-hooks/protocol';
import type { PausePayload } from '@qa-debug/pause-store-types';

import { CdpBinding } from './cdp-binding.js';
import type { InspectionArbiter } from './inspection-arbiter.js';
import type { DecisionRouter } from './decision-router.js';
import type { QaDebugMcpProvider } from './mcp-provider.js';
import { startMochaIpcServer, type MochaIpcServer } from './mocha-ipc-server.js';
import { appendInfo } from './output-channel.js';
import { signalProcessGroup } from './process-group-kill.js';
import type { PauseStatusBar } from './pause-status-bar.js';
import type { MementoPauseStore } from './pause-store.js';
import { buildAlternationGrep, resolveCwd, resolveMochaEntry } from './project-resolve.js';
import type { RunStatusBar } from './run-status-bar.js';
import type { RunSelection, TestControllerWrapper, TestRunHandle } from './test-controller.js';

// v5.5 unified-id formula `file::it::full_title`. Must match
// test-controller's lookupOrCreateTestItem so the context-key array set here
// intersects with the testId VS Code passes through testing/item/context.
function computeTestItemId(pause: PausePayload): string {
  return `${vscode.Uri.file(pause.file).toString()}::it::${pause.full_title}`;
}

async function refreshPausedTestIdsContext(pauseStore: MementoPauseStore): Promise<void> {
  const active = pauseStore.peekActivePause();
  const ids = active ? [computeTestItemId(active)] : [];
  await vscode.commands.executeCommand('setContext', 'qa-debug.pausedTestIds', ids);
}

// Grace window between the polite group signal (SIGINT, = Ctrl-C) and the hard
// SIGKILL escalation. Env override for tests so they don't wait the full default.
const KILL_GRACE_MS = Number(process.env.QA_DEBUG_KILL_GRACE_MS ?? 3_000);

// Task definition type for the terminal-hosted mocha run. Must match the
// `taskDefinitions` contribution in package.json.
const MOCHA_TASK_TYPE = 'qa-debug-mocha';

// v5.2: absolute-path resolution for bundled hook + reporter. Resolved
// once at module load from the extension's own location via createRequire.
// fs.existsSync guard catches VSIX-misdeploy at extension activation (clearer
// than failing inside mocha child later). Per the VSIX-packaging risk row.
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
        `See ARCHITECTURE.md §5 risk row "VSIX packaging discipline".`,
    );
  }
}

export interface SessionManagerDeps {
  pauseStore: MementoPauseStore;
  decisionRouter: DecisionRouter;
  mcpProvider: QaDebugMcpProvider;
  testControllerWrapper: TestControllerWrapper;
  channel: vscode.OutputChannel;
  /** Workspace root used to resolve mocha bin + fallback CWD. */
  workspaceRoot: string;
  /**
   * Retained from v5.3 deps shape; no longer read by the notification handler
   * (v5.4 dropped the "Ask Copilot" button). Probed at activation for future
   * re-use by other engagement paths.
   */
  chatOpenAvailable: boolean;
  chatOpenFallbackAvailable: boolean;
  /** v5.4 — ambient pause indicator; show on pause-publish, hide on decision commit. */
  pauseStatusBar: PauseStatusBar;
  /** Ambient run indicator; show on startMochaTask, hide on onMochaExit. */
  runStatusBar: RunStatusBar;
  /** Shared mutual-exclusion guard vs. the Live Inspect Session (both bind the
   *  single-endpoint mcpProvider). */
  arbiter: InspectionArbiter;
}

interface ActiveRun {
  testHandle: TestRunHandle;
  /** VS Code task execution backing this run; undefined until executeTask resolves. */
  execution?: vscode.TaskExecution;
  /**
   * PID of the task's root process (`node <mocha.js>`), from
   * onDidStartTaskProcess. The pty makes it a session (and thus group) leader,
   * so the group-signal semantics of the old `detached: true` spawn carry over.
   */
  pid?: number;
  /** Per-run pipe/socket endpoint the mocha child dials back to. */
  ipc: MochaIpcServer;
  /** Task lifecycle subscriptions; disposed in onMochaExit. */
  taskSubs: vscode.Disposable[];
  connection: JsonRpcConnection;
  heartbeatTimers: Map<string, NodeJS.Timeout>;
  /** session_ids whose decision.await is currently pending. */
  pendingSessions: Set<string>;
  /** CWD this run was spawned with. */
  cwd: string;
  /** Mocha bin used. */
  mochaEntry: string;
  /** Set by cancelActiveRun() so onMochaExit can attribute the exit to the user. */
  userCancelled: boolean;
  /**
   * Guards double exit handling: onDidEndTaskProcess and onDidEndTask both
   * fire for a normal exit, and the executeTask catch path calls in directly.
   */
  exited: boolean;
  /**
   * Set once pause teardown (clear store + context key + MCP gate + shim +
   * finalize the Test Explorer item) has run for this run's active pause —
   * whether via the `final_decision` notification (normal path) or the
   * child-exit fallback in onMochaExit (kill / crash). Dedupes the two paths.
   */
  pauseToreDown: boolean;
  /**
   * Armed by terminateRun() after the polite group SIGINT; fires a group
   * SIGKILL if the child hasn't exited within KILL_GRACE_MS. Cleared in
   * onMochaExit().
   */
  killEscalationTimer?: NodeJS.Timeout;
}

export interface RunFixtureSuiteOptions {
  /**
   * Spec file URIs to run. If non-empty, CWD is derived from path.dirname
   * of the first URI's fsPath (per NB6 recommended default).
   * If empty/undefined, CWD falls back to `<workspaceRoot>/fixture-tests`
   * (legacy demo flow) or `<workspaceRoot>` (generic run-all).
   */
  specs?: readonly vscode.Uri[];
  /** Test-run label surfaced in Test Explorer. */
  runLabel?: string;
  /**
   * v5.17 — raw test selection. SessionManager generates a unique grep marker,
   * passes the selection to qa-hooks via env vars, and qa-hooks tags matching
   * tests with the marker so mocha's `--grep <marker>` runs exactly them. See
   * `mocha-hooks/src/qa-hooks.ts` `installRunSelectionMarkerPatch`.
   */
  runSelection?: RunSelection;
  /**
   * v5.5 C2 — wired to terminateRun() on cancellation: a Ctrl-C-equivalent
   * SIGINT to the whole process group, with a SIGKILL escalation if it hangs.
   */
  cancellationToken?: vscode.CancellationToken;
}

export class SessionManager {
  private activeRun?: ActiveRun;
  private readonly chromeEventSubscriptions: { dispose(): void }[] = [];
  /**
   * Endpoint→MCP binding incl. the CDP download-shim hop, 1:1 with the current
   * chrome selection. Shared implementation with LiveSessionManager — see
   * cdp-binding.ts.
   */
  private readonly cdpBinding: CdpBinding;

  constructor(private readonly deps: SessionManagerDeps) {
    this.cdpBinding = new CdpBinding(deps.mcpProvider, deps.channel, '[session-manager]');
    // v5.16 — gate mcpProvider.setPaused on chrome selection events. Two paths
    // feed this funnel: agent via qa-debug_qa_select_chrome (LM tool) and
    // extension UI via QuickPick / InputBox. Both write through
    // PauseStore.recordChromeSelection which awaits persistence before firing
    // onChromeSelected.
    this.chromeEventSubscriptions.push(
      this.deps.pauseStore.onChromeSelected((selection) => {
        // The onChromeSelected emitter ignores the returned promise — MCP
        // registration is already async on the VS Code side, so the brief gap
        // before setPaused is benign.
        void this.cdpBinding.bindMcp(
          selection.cdp_ws_url,
          ` port=${selection.port} source=${selection.source} session=${selection.session_id}`,
        );
      }),
      this.deps.pauseStore.onChromeDeselected((sessionId) => {
        void this.cdpBinding.stopShim();
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
    // Bidirectional guard: a Mocha run (→ pause → mcpProvider.setPaused) must not
    // start on top of a Live Inspect Session — they fight over the single MCP
    // endpoint. LiveSessionManager.launch refuses the reverse.
    if (!this.deps.arbiter.canStart('run')) {
      void vscode.window.showWarningMessage(
        `QA Debug: cannot start a suite run — ${this.deps.arbiter.blockingReason()}. ` +
          `Stop the Live Inspect Session first.`,
      );
      return;
    }
    const specFiles = (opts.specs ?? []).map((u) => u.fsPath);
    const cwd = resolveCwd(specFiles, this.deps.workspaceRoot);
    const mochaEntry = resolveMochaEntry(cwd, this.deps.workspaceRoot);
    const testHandle = this.deps.testControllerWrapper.beginRun(
      opts.runLabel ?? (specFiles.length === 1 ? path.basename(specFiles[0]) : 'fixture suite'),
    );
    await this.startMochaTask(testHandle, {
      cwd,
      mochaEntry,
      specFiles,
      runSelection: opts.runSelection,
      cancellationToken: opts.cancellationToken,
    });
  }

  /** Tear down everything; called from extension deactivate. */
  async dispose(): Promise<void> {
    if (this.activeRun) {
      // Deactivate can't await the grace timer, so terminateRun's SIGINT is
      // followed by an immediate group SIGKILL to avoid orphaning the launched
      // browser when VS Code is closing.
      const run = this.activeRun;
      run.userCancelled = true;
      this.terminateRun(run, 'extension deactivate');
      if (run.pid != null) {
        signalProcessGroup(run.pid, 'SIGKILL', (m) => appendInfo(this.deps.channel, m));
      }
      clearTimeout(run.killEscalationTimer);
      for (const sub of run.taskSubs) sub.dispose();
      run.taskSubs.length = 0;
      run.connection.close();
      await run.ipc.dispose();
      this.activeRun = undefined;
      this.deps.arbiter.setRunActive(false);
      void vscode.commands.executeCommand('setContext', 'qa-debug.running', false);
      this.deps.runStatusBar.hide();
    }
    for (const sub of this.chromeEventSubscriptions) {
      sub.dispose();
    }
    this.chromeEventSubscriptions.length = 0;
    // Release the proxy port on deactivate.
    await this.cdpBinding.stopShim();
  }

  // ------------------- internal -------------------

  private async startMochaTask(
    testHandle: TestRunHandle,
    opts: {
      cwd: string;
      mochaEntry: string;
      runSelection?: RunSelection;
      specFiles?: string[];
      cancellationToken?: vscode.CancellationToken;
    },
  ): Promise<void> {
    // v5.2: inject --require + --reporter as absolute paths to the
    // extension-bundled hook/reporter. User .mocharc.cjs needs no edits.
    // v5.17 — `--no-timeouts` overrides the consumer's `.mocharc` default
    // (typically 2000ms) so pause-debug runs aren't killed by a beforeAll
    // hook timeout while the QA inspects the browser. qa-hooks separately
    // calls this.timeout(0) inside its afterEach for defense-in-depth.
    const args: string[] = [
      '--require',
      REGISTER_PATH,
      '--reporter',
      REPORTER_PATH,
      '--no-timeouts',
    ];

    // v5.17 — anchored alternation `--grep`. Each entry is its own anchored
    // alternative so exact-match semantics hold (siblings under the same
    // top-level describe DON'T over-select). The first alts are the top-level
    // suite titles, included so consumer test-framework wrappers
    // (e.g. `@tr/mocha-runner-hooks`) whose sniffer tests `--grep` against
    // `this.suite.suites[].title` only see at least one match and don't emit
    // a misleading `NO TEST CASES MATCHED` log even though mocha runs the
    // selected tests fine.
    if (
      opts.runSelection &&
      (opts.runSelection.fullTitles.length > 0 ||
        opts.runSelection.describePrefixes.length > 0)
    ) {
      const grep = buildAlternationGrep(opts.runSelection);
      args.push('--grep', grep);
    }

    if (opts.specFiles && opts.specFiles.length > 0) {
      args.push(...opts.specFiles);
    }

    // v5.18 — per-run dial-back endpoint; replaces stdio[3]='ipc', which can't
    // exist here (the task process is the pty host's child, not ours).
    const ipc = await startMochaIpcServer((m) => appendInfo(this.deps.channel, m));

    appendInfo(
      this.deps.channel,
      `[session-manager] start mocha task cwd=${opts.cwd} entry=${opts.mochaEntry} ` +
        `args=${JSON.stringify(args)} ipc=${ipc.endpoint}`,
    );

    // v5.18 — the run lives in a VS Code task terminal instead of an invisible
    // extension-host child:
    //  - the QA watches mocha/qa-reporter output live (ANSI colors intact) and
    //    can Ctrl-C the run — the real thing terminateRun's group-SIGINT
    //    emulates;
    //  - ProcessExecution passes the argv ARRAY straight to the process (no
    //    shell), killing the Windows cmd-quoting / .cmd-shim class of spawn
    //    bugs, and `node` resolves from the user's terminal PATH;
    //  - the terminal env comes from the user's shell, already scrubbed of
    //    ELECTRON_RUN_AS_NODE & friends by VS Code's own
    //    sanitizeProcessEnvironment — the sanitizeChildEnv pass the old
    //    direct-child path needed (v5.16) is moot here. Only our additive var
    //    rides along: ProcessExecutionOptions.env is MERGED over the terminal
    //    env per the API contract.
    //
    // Definition and name are deliberately CONSTANT: task identity derives
    // from them, and a per-run identity would defeat TaskPanelKind.Dedicated —
    // every run would open yet another terminal instead of reusing (+clearing)
    // the previous one. Event attribution doesn't need a per-run marker:
    // runFixtureSuite guarantees a single active run, so any event for a task
    // of our type belongs to it.
    const task = new vscode.Task(
      { type: MOCHA_TASK_TYPE },
      vscode.TaskScope.Workspace,
      'mocha',
      'qa-debug',
      new vscode.ProcessExecution('node', [opts.mochaEntry, ...args], {
        cwd: opts.cwd,
        env: { QA_DEBUG_IPC_ENDPOINT: ipc.endpoint },
      }),
    );
    task.presentationOptions = {
      // Reveal without stealing focus so a stalled run is already visible
      // instead of a scavenger hunt — same intent as the old channel.show().
      reveal: vscode.TaskRevealKind.Always,
      focus: false,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      echo: true,
      showReuseMessage: false,
    };
    task.problemMatchers = [];

    const connection = new JsonRpcConnection(ipc.transport);
    const run: ActiveRun = {
      testHandle,
      ipc,
      taskSubs: [],
      connection,
      heartbeatTimers: new Map(),
      pendingSessions: new Set(),
      cwd: opts.cwd,
      mochaEntry: opts.mochaEntry,
      userCancelled: false,
      exited: false,
      pauseToreDown: false,
    };
    this.activeRun = run;
    this.deps.arbiter.setRunActive(true);
    void vscode.commands.executeCommand('setContext', 'qa-debug.running', true);
    this.deps.runStatusBar.show();

    // v5.5 C2 — Test Explorer native stop button: route through terminateRun so
    // the whole group (mocha + launched browser + workers) gets the
    // Ctrl-C-equivalent SIGINT, with SIGKILL escalation. Mark userCancelled so
    // onMochaExit attributes the exit to the user. Registered after `run` is
    // built so the closure can reference it.
    opts.cancellationToken?.onCancellationRequested(() => {
      run.userCancelled = true;
      this.terminateRun(run, 'Test Explorer cancellation token');
    });

    this.wireConnection(run);

    // Subscribed BEFORE executeTask: onDidStartTaskProcess can fire before the
    // executeTask thenable resolves. Matched on the task type — TaskExecution
    // object identity across the API boundary is not contractual, and the
    // single-active-run guard makes the type sufficient.
    run.taskSubs.push(
      vscode.tasks.onDidStartTaskProcess((e) => {
        if (e.execution.task.definition.type !== MOCHA_TASK_TYPE) return;
        run.pid = e.processId;
        appendInfo(
          this.deps.channel,
          `[session-manager] mocha task process started pid=${e.processId}`,
        );
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task.definition.type !== MOCHA_TASK_TYPE) return;
        appendInfo(
          this.deps.channel,
          `[session-manager] mocha exited code=${e.exitCode ?? '?'}` +
            (run.ipc.connected()
              ? ''
              : ' (child never dialed the IPC endpoint — qa-hooks not loaded?)'),
        );
        void this.onMochaExit(run);
      }),
      // Fallback for a task that ends without ever producing a process (spawn
      // refusal); onMochaExit dedupes via run.exited.
      vscode.tasks.onDidEndTask((e) => {
        if (e.execution.task.definition.type !== MOCHA_TASK_TYPE) return;
        void this.onMochaExit(run);
      }),
    );

    try {
      run.execution = await vscode.tasks.executeTask(task);
    } catch (err) {
      // Per the API docs, executeTask throws when a ProcessExecution cannot
      // start a new process at all. The terminal also shows the failure to
      // the user — keep the toast for parity with the old spawn-error path.
      appendInfo(
        this.deps.channel,
        `[session-manager] mocha task failed to start: ${(err as Error).message}`,
      );
      void vscode.window.showErrorMessage(
        `QA Debug: failed to start mocha task — ${(err as Error).message}`,
      );
      await this.onMochaExit(run);
    }
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
      // v5.16 — mcpProvider.setPaused is gated on a committed chrome selection.
      // Don't fire here. Auto-select when exactly one chrome was discovered;
      // otherwise wait for agent (qa_select_chrome / qa_discover_chromes) or
      // extension UI to commit.
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
      // v5.4 — ambient status-bar entry augments the notification toast.
      this.deps.pauseStatusBar.show(sessionId);

      // v5.4 — two-button notification (Ask Copilot removed); body text
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
          // v5.4 — entry hides within 500ms of commit; the
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
      await this.teardownPause(run, decision, pause);
    });
  }

  /**
   * Single chokepoint for ending an active pause: finalize the Test Explorer
   * item (clears the ⏸ busy spinner), clear the pause store + `qa-debug.paused`
   * context key, close the playwright-mcp gate, and release the CDP shim port.
   *
   * Called from two places:
   *  - the `final_decision` IPC notification (normal commit via UI / agent verb);
   *  - onMochaExit's fallback, when a killed / crashed child died before it could
   *    send `final_decision` and the pause is still active.
   * `run.pauseToreDown` dedupes the two so a final_decision that lands just
   * before child-exit doesn't get a redundant second teardown.
   */
  private async teardownPause(
    run: ActiveRun,
    decision: FinalDecisionParams,
    pause: PausePayload | undefined,
  ): Promise<void> {
    if (run.pauseToreDown) return;
    run.pauseToreDown = true;
    run.testHandle.recordDecision(decision, pause);
    await this.deps.pauseStore.clearActivePause();
    await vscode.commands.executeCommand('setContext', 'qa-debug.paused', false);
    await refreshPausedTestIdsContext(this.deps.pauseStore);
    this.deps.mcpProvider.setIdle();
    // Pause ended; release the shim proxy port.
    await this.cdpBinding.stopShim();
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
    // onDidEndTaskProcess + onDidEndTask both fire on a normal exit, and the
    // executeTask catch path calls in directly — first one wins.
    if (run.exited) return;
    run.exited = true;
    const abandonReason = run.userCancelled
      ? 'mocha child cancelled by user (no final_decision)'
      : 'mocha child exited unexpectedly (no final_decision)';
    for (const sessionId of run.pendingSessions) {
      this.deps.decisionRouter.abandon(sessionId, abandonReason, 'hook');
    }
    for (const timer of run.heartbeatTimers.values()) clearInterval(timer);
    run.heartbeatTimers.clear();
    run.pendingSessions.clear();
    // Child exited (cleanly or via the polite SIGINT) before the grace window;
    // cancel the pending SIGKILL.
    clearTimeout(run.killEscalationTimer);
    run.killEscalationTimer = undefined;

    // Fallback pause teardown: the normal teardown rides the `final_decision`
    // IPC notification, but a killed / crashed child dies before sending it,
    // which previously left the pause store, the `qa-debug.paused` context key,
    // the playwright-mcp gate, the CDP shim, and the Test Explorer ⏸ spinner all
    // stuck. If a pause is still active here, tear it down with a synthesized
    // give_up. No-op on the normal path (final_decision already set
    // pauseToreDown / cleared the store).
    const orphanPause = this.deps.pauseStore.peekActivePause();
    if (orphanPause && !run.pauseToreDown) {
      const synthetic: FinalDecisionParams = {
        session_id: orphanPause.session_id,
        kind: 'give_up',
        reason: abandonReason,
        by: 'hook',
        full_title: orphanPause.full_title,
        test_file: orphanPause.file,
      };
      await this.teardownPause(run, synthetic, orphanPause);
    }

    // Release the task listeners and the per-run IPC endpoint.
    for (const sub of run.taskSubs) sub.dispose();
    run.taskSubs.length = 0;
    run.connection.close();
    await run.ipc.dispose();

    if (this.activeRun === run) {
      this.activeRun = undefined;
      this.deps.arbiter.setRunActive(false);
      void vscode.commands.executeCommand('setContext', 'qa-debug.running', false);
      this.deps.runStatusBar.hide();
    }

    run.testHandle.end();
  }

  /**
   * User-initiated cancel: interrupt the active run's whole process group
   * (Ctrl-C-equivalent SIGINT, then SIGKILL escalation). Returns false when
   * there is no active run. Cleanup (heartbeats, decision abandonment, context
   * keys) flows through the existing onDidEndTaskProcess → onMochaExit path.
   */
  cancelActiveRun(reason: string): boolean {
    const run = this.activeRun;
    if (!run) return false;
    run.userCancelled = true;
    this.terminateRun(run, reason);
    return true;
  }

  /**
   * Single chokepoint for tearing a run down. Sends a Ctrl-C-equivalent SIGINT
   * to the whole process group now, and arms a SIGKILL escalation in case the
   * group ignores or hangs on it (e.g. a framework SIGINT handler blocked on
   * the paused browser). The escalation is cancelled in onMochaExit if the
   * child exits within the grace window. Idempotent: re-entry while a timer is
   * armed only logs.
   */
  private terminateRun(run: ActiveRun, reason: string): void {
    const pid = run.pid;
    if (pid == null) {
      // The task process hasn't started yet (or never will — spawn refusal).
      // Nothing to group-signal; let VS Code tear the task down if it exists.
      appendInfo(
        this.deps.channel,
        `[session-manager] terminate before process start reason="${reason}" — execution.terminate()`,
      );
      run.execution?.terminate();
      return;
    }
    if (run.killEscalationTimer) {
      appendInfo(
        this.deps.channel,
        `[session-manager] terminate re-entry pid=${pid} reason="${reason}" (escalation already armed)`,
      );
      return;
    }
    appendInfo(
      this.deps.channel,
      `[session-manager] terminate run; SIGINT process group pid=-${pid} reason="${reason}"`,
    );
    signalProcessGroup(pid, 'SIGINT', (m) => appendInfo(this.deps.channel, m));
    run.killEscalationTimer = setTimeout(() => {
      // Guard: only escalate if THIS run is still the active, un-exited one — a
      // recycled PID could otherwise belong to a different group by now.
      if (this.activeRun !== run) return;
      appendInfo(
        this.deps.channel,
        `[session-manager] group still alive after ${KILL_GRACE_MS}ms; SIGKILL process group pid=-${pid}`,
      );
      signalProcessGroup(pid, 'SIGKILL', (m) => appendInfo(this.deps.channel, m));
    }, KILL_GRACE_MS);
  }

}

function wireToStored(wire: WirePausePayload, sessionId: string): PausePayload {
  const stackFrames = (wire.error.stack ?? '').split('\n').slice(1).map((s) => s.trimStart());
  return {
    session_id: sessionId,
    test_title: wire.test,
    // v5.5 — pass the canonical full title through to the store so
    // TestController.recordPause can look up the discovery TestItem by unified id.
    full_title: wire.full_title,
    file: wire.file ?? '<unknown>',
    line: wire.line ?? undefined,
    failing_assertion: wire.error.message,
    stack_trace: { frames: stackFrames },
    // v5.16 — Mode C discovery fields are the only browser-state surface.
    available_chromes: wire.available_chromes,
    selected_cdp_port: wire.selected_cdp_port,
    chrome_owner: wire.chrome_owner,
    console_logs: { lines: [], bytes: 0 },
    paused_at_ms: wire.started_at,
    retry_count: wire.retry_count,
    max_retries_remaining: 0,
  };
}
