/**
 * SessionManager — owns the mocha child + Chrome lifecycle and routes IPC
 * traffic between hook (`qa-hooks.ts`) and extension state (PauseStore +
 * DecisionRouter + TestController + MCP provider).
 *
 * S4_DESIGN.md §6, §10, §11.
 *
 * Suite-run sequence:
 *   1. runFixtureSuite() called via qa-debug.runFixture command or TestController
 *      run handler.
 *   2. Chrome.spawn() (idempotent — reuse across tests).
 *   3. controller.beginRun() returns a TestRunHandle scoped to this invocation.
 *   4. spawn mocha child with stdio[3]='ipc' + --require qa-hooks +
 *      --reporter qa-reporter.
 *   5. Construct JsonRpcConnection on the child. Register handlers.
 *   6. Wait for child exit. On clean exit with no outstanding pause, tear down
 *      Chrome. On exit with outstanding pause, leave Chrome up (per §6.3).
 *
 * Retry flow (§10):
 *   - On final_decision { kind: 'retry' }: queue a respawn task.
 *   - After current child exits, spawn new mocha with --grep '^<escaped>$' on
 *     the same spec file. The TestRunHandle stays alive across respawn so the
 *     same TestItem (per §7.3 id formula) receives subsequent events.
 *
 * Stale-resume flow (§11):
 *   - resumeStalePauseIfAny() — called once on activate. If the Memento has an
 *     active pause, flip context key + setPaused on McpProvider + show
 *     stale-resume notification with Give Up only. The DecisionRouter has no
 *     pending callback (the original mocha child is dead), so a Give Up click
 *     locally clears the pause via the same code path as commit, just without
 *     IPC. The qa-debug.staleResume context key disables Retry / Mark Passed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import type { MementoPauseStore } from './pause-store.js';
import type { TestControllerWrapper, TestRunHandle } from './test-controller.js';

const HEARTBEAT_MS = Number(process.env.QA_DEBUG_HEARTBEAT_MS ?? 5_000);
const FIXTURE_DIR = 'fixture-tests';

export interface SessionManagerDeps {
  pauseStore: MementoPauseStore;
  decisionRouter: DecisionRouter;
  chrome: ChromeProcess;
  mcpProvider: QaDebugMcpProvider;
  testControllerWrapper: TestControllerWrapper;
  channel: vscode.OutputChannel;
  /** Workspace root used to resolve mocha bin + fixture-tests cwd. */
  workspaceRoot: string;
}

interface ActiveRun {
  testHandle: TestRunHandle;
  child: ChildProcess;
  connection: JsonRpcConnection;
  heartbeatTimers: Map<string, NodeJS.Timeout>;
  /** session_ids whose decision.await is currently pending. */
  pendingSessions: Set<string>;
  /** Outstanding retry request to fire after `child` exits. */
  retryAfterExit?: { specFile: string; testTitle: string };
}

export class SessionManager {
  private activeRun?: ActiveRun;

  constructor(private readonly deps: SessionManagerDeps) {}

  /** Entrypoint for qa-debug.runFixture + TestController run handler. */
  async runFixtureSuite(grep?: string, specFile?: string): Promise<void> {
    if (this.activeRun) {
      void vscode.window.showWarningMessage(
        'QA Debug: a suite run is already in progress.',
      );
      return;
    }
    await this.deps.chrome.spawn();
    const testHandle = this.deps.testControllerWrapper.beginRun(
      specFile ? path.basename(specFile) : 'fixture suite',
    );
    await this.spawnMochaChild(testHandle, { grep, specFile });
  }

  /**
   * On activate, peek the Memento for a stale pause. If found, surface the
   * reduced-action-surface UI per §11.
   */
  async resumeStalePauseIfAny(): Promise<void> {
    const stale = this.deps.pauseStore.peekActivePause();
    if (!stale) return;
    appendInfo(this.deps.channel, `[session-manager] stale-resume detected session=${stale.session_id}`);
    await vscode.commands.executeCommand('setContext', 'qa-debug.paused', true);
    await vscode.commands.executeCommand('setContext', 'qa-debug.staleResume', true);
    this.deps.mcpProvider.setPaused(stale.cdp_ws_url.replace(/^ws:/, 'http:'));
    // Enroll a "synthetic" pending callback so Give Up has something to commit.
    // Locally resolved — no IPC round-trip — but reuses the same code path.
    this.deps.decisionRouter.enroll(stale.session_id, async (decision) => {
      appendInfo(
        this.deps.channel,
        `[session-manager] stale-resume resolved session=${stale.session_id} kind=${decision.kind}`,
      );
      await this.deps.pauseStore.clearActivePause();
      await vscode.commands.executeCommand('setContext', 'qa-debug.paused', false);
      await vscode.commands.executeCommand('setContext', 'qa-debug.staleResume', false);
      this.deps.mcpProvider.setIdle();
    });
    void vscode.window.showInformationMessage(
      `QA Debug: last suite was interrupted while a pause was active (test: "${stale.test_title}"). ` +
        `The browser state is no longer available. Choose **Give Up** in Test Explorer to clear, or close to defer.`,
      'Open Audit Log',
    ).then((sel) => {
      if (sel === 'Open Audit Log') this.deps.channel.show();
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
    await this.deps.chrome.dispose();
  }

  // ------------------- internal -------------------

  private async spawnMochaChild(
    testHandle: TestRunHandle,
    opts: { grep?: string; specFile?: string },
  ): Promise<void> {
    const mochaBin = this.resolveMochaBin();
    const args: string[] = [];
    if (opts.grep) {
      args.push('--grep', opts.grep);
    }
    if (opts.specFile) {
      args.push(opts.specFile);
    }

    const cwd = path.join(this.deps.workspaceRoot, FIXTURE_DIR);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      QA_DEBUG_CDP_WS_URL: this.deps.chrome.cdpWsEndpoint,
    };

    appendInfo(this.deps.channel, `[session-manager] spawn mocha cwd=${cwd} args=${JSON.stringify(args)}`);
    const child = spawn(mochaBin, args, {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env,
    });

    const connection = new JsonRpcConnection(nodeIpcTransport(child));
    const run: ActiveRun = {
      testHandle,
      child,
      connection,
      heartbeatTimers: new Map(),
      pendingSessions: new Set(),
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
      this.deps.mcpProvider.setPaused(this.deps.chrome.cdpHttpEndpoint);
      run.testHandle.recordPause(stored);

      void vscode.window.showInformationMessage(
        `QA Debug: test "${stored.test_title}" failed at ${path.basename(stored.file)}:${stored.line ?? '?'}. ` +
          `Browser held at :9222. Ask Copilot to investigate.`,
        'Open Test Explorer',
        'Open Audit Log',
      ).then((sel) => {
        if (sel === 'Open Audit Log') this.deps.channel.show();
        if (sel === 'Open Test Explorer') {
          void vscode.commands.executeCommand('workbench.view.testing.focus');
        }
      });

      appendInfo(
        this.deps.channel,
        `[session-manager] pause session=${sessionId} test="${stored.test_title}"`,
      );
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
          resolve(decision);
        });
        this.startHeartbeats(run, params.session_id, params.heartbeat_ms);
      });
    });

    connection.onNotification(METHOD.finalDecision, async (raw) => {
      const decision = FinalDecisionParams.parse(raw);
      const pause = this.peekPauseForFinalDecision(decision);
      run.testHandle.recordDecision(decision, pause);

      if (decision.kind === 'retry') {
        // Queue respawn to fire after the current mocha child exits.
        if (pause?.file) {
          run.retryAfterExit = { specFile: pause.file, testTitle: decision.test_title };
        }
        // Don't clear pause yet — the respawn will overwrite with a new pause if it fails again.
        return;
      }

      // mark_passed / give_up — clear the pause and gate.
      await this.deps.pauseStore.clearActivePause();
      await vscode.commands.executeCommand('setContext', 'qa-debug.paused', false);
      this.deps.mcpProvider.setIdle();
    });
  }

  private peekPauseForFinalDecision(decision: FinalDecisionParams): PausePayload | undefined {
    // The Memento may have cleared by the time this notification handler runs
    // (the decision-router commit happens before the hook emits final_decision,
    // and recordDecision in PauseStore doesn't clear active). In practice the
    // active pause should still be present when final_decision arrives.
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
    // Synthesize give_up for any sessions still pending — §9.3 row 1.
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

    if (run.retryAfterExit) {
      const { specFile, testTitle } = run.retryAfterExit;
      appendInfo(
        this.deps.channel,
        `[session-manager] respawn for retry: spec=${specFile} test="${testTitle}"`,
      );
      // Reuse the same TestRunHandle so the TestItem (id includes file + title)
      // receives subsequent pause-publishes.
      await this.spawnMochaChild(run.testHandle, {
        grep: `^${escapeRegex(testTitle)}$`,
        specFile,
      });
      return;
    }

    // Clean exit: tear down Chrome IF no outstanding pause survives.
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

  private resolveMochaBin(): string {
    const root = this.deps.workspaceRoot;
    const candidates = [
      path.join(root, FIXTURE_DIR, 'node_modules', '.bin', 'mocha'),
      path.join(root, 'node_modules', '.bin', 'mocha'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error(
      `Could not find mocha binary at any of: ${candidates.join(', ')}. Did pnpm install run?`,
    );
  }
}

/**
 * Translate the wire payload (mocha-hooks/src/protocol.ts PausePayload shape)
 * to the richer in-extension shape (pause-store-types PausePayload) by
 * filling in derived fields.
 */
function wireToStored(wire: WirePausePayload, sessionId: string): PausePayload {
  const stackFrames = (wire.error.stack ?? '').split('\n').slice(1).map((s) => s.trimStart());
  return {
    session_id: sessionId,
    test_title: wire.test,
    file: wire.file ?? '<unknown>',
    line: wire.line ?? undefined,
    failing_assertion: wire.error.message,
    stack_trace: { frames: stackFrames },
    cdp_ws_url: wire.cdp_ws_url,
    console_logs: { lines: [], bytes: 0 }, // Phase 2 capture; S4 leaves empty
    paused_at_ms: wire.started_at,
    retry_count: wire.retry_count,
    max_retries_remaining: 0, // No native retries per ARCH §3.1
  };
}

/** §6.4.1 — escape regex metacharacters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Reference: HEARTBEAT_MS lives in the module scope so future timer logic can
// pick it up; the IPC handler currently uses the value the hook supplies in
// DecisionAwaitParams.heartbeat_ms (mirrors HEARTBEAT_MS via env).
void HEARTBEAT_MS;
