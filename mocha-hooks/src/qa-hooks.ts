// Mocha root hook plugin. Held inside the test runner process.
// Parent (oracle in S2 / extension in S4) spawns mocha with `stdio: [..., 'ipc']`
// and we communicate via Node IPC carrying JSON-RPC 2.0 envelopes.
// See ARCHITECTURE.md §3.1 / §3.5 and mocha-hooks/README.md.

import {
  DecisionAwaitParams,
  DecisionResult,
  FinalDecisionParams,
  HeartbeatParams,
  JsonRpcConnection,
  METHOD,
  PausePayload,
  PausePublishResult,
  SerializedError,
  inProcBus,
  nodeIpcTransport,
} from './protocol';

// Heartbeat interval expected from the parent (extension / oracle). Parent should
// send a `heartbeat` notification every HEARTBEAT_MS while it's still alive holding
// a pause; the hook abandons (resolves locally as give_up) after MAX_MISSED_HEARTBEATS
// consecutive intervals without one. Env override is for testing the abandoned path
// without waiting 15s; production should leave the default.
const HEARTBEAT_MS = Number(process.env.QA_DEBUG_HEARTBEAT_MS ?? 5_000);
const MAX_MISSED_HEARTBEATS = 3;

let conn: JsonRpcConnection | undefined;
let connDisabledReason: string | undefined;

// ---------- v5.2 Mode A: wdio.remote() monkey-patch + CDP discovery ----------
// Per ARCHITECTURE-CR-v5.2 §2.2: at --require time, probe for webdriverio
// cheaply via require.resolve (no module execution per nodejs.org/api/modules.html).
// If found, require() the package and install an Object.defineProperty getter
// on `remote` that wraps the original and captures the returned browser in a
// module-scope singleton. afterEach then discovers the CDP WS URL via
// browser.getPuppeteer().wsEndpoint(), wrapped in try/catch because getPuppeteer
// has a four-branch capability dispatch and throws when none match (cloud grids,
// non-Chromium, etc.) per webdriverio/v8.40.6/.../getPuppeteer.ts.
//
// Known Phase 1 limitations (per CR §2.5 + §3.4.1):
//  - Destructured `import { remote } from 'webdriverio'` at module top-level
//    captures the pre-patch value. Mode B silently engages with audit-log line.
//  - Native-ESM (no transpiler) bypasses CJS require.cache; Mode B engages.
//  - Cloud grids / non-Chromium hit the getPuppeteer throw; Mode B engages.

interface WdioBrowserLike {
  getPuppeteer?: () => Promise<{ wsEndpoint?: () => string }>;
}

let currentBrowser: WdioBrowserLike | undefined;

(function installWdioPatch(): void {
  // B3 cheap probe — resolves filename without executing the module.
  let wdioPath: string | undefined;
  try {
    wdioPath = require.resolve('webdriverio');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'MODULE_NOT_FOUND') throw err;
    return; // wdio not installed — Mode B fallback engages later
  }

  // Eager load is acceptable here: cheap probe confirmed wdio is a real dep,
  // so the 50–150ms cold-start tax is paid by users who actually want Mode A.
  let wdio: { remote?: unknown } & Record<string, unknown>;
  try {
    wdio = require(wdioPath) as { remote?: unknown } & Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`[qa-hooks] wdio probe loaded but require() threw: ${(err as Error).message}\n`);
    return;
  }

  const originalRemote = wdio.remote;
  if (typeof originalRemote !== 'function') {
    process.stderr.write(`[qa-hooks] wdio.remote is not a function (got ${typeof originalRemote}); Mode A skipped\n`);
    return;
  }

  const patchedRemote = async function patchedRemote(this: unknown, ...args: unknown[]): Promise<unknown> {
    const browser = await (originalRemote as Function).apply(this, args);
    currentBrowser = browser as WdioBrowserLike;
    return browser;
  };

  // B5 defensive: Object.defineProperty with getter keeps the binding live
  // through esbuild/tsc-generated CJS export descriptors. Strict-mode naked
  // assignment on a read-only data property throws; sloppy-mode silently
  // no-ops. The post-write equality check catches the sloppy-mode silent-
  // failure path and falls back to Mode B with an audit log line.
  try {
    Object.defineProperty(wdio, 'remote', {
      configurable: true,
      get: () => patchedRemote,
    });
  } catch {
    try {
      (wdio as { remote: unknown }).remote = patchedRemote;
    } catch (err) {
      process.stderr.write(`[qa-hooks] could not patch wdio.remote: ${(err as Error).message}; Mode B fallback engages\n`);
      return;
    }
  }
  // Sloppy-mode silent-failure equality re-check per CR §5.
  if ((wdio as { remote: unknown }).remote !== patchedRemote) {
    process.stderr.write(
      `[qa-hooks] wdio.remote patch silently failed (sloppy-mode no-op); Mode B fallback engages\n`,
    );
    return;
  }
  // v5.3 §2.6 positive logging: confirms Mode A patch installed; lets engineers
  // verify from Output Channel without re-running with custom instrumentation.
  process.stderr.write(`[qa-hooks] wdio.remote patch installed (path=${wdioPath})\n`);
})();

// Note: discoverCdpWsUrl was inlined into afterEach in sub-phase 14c so the
// mode-detection result (Mode A vs Mode B) can be captured alongside the URL
// for the PausePayload.mode field. The capability-branch try/catch logic
// remains structurally identical.

function getConnection(): JsonRpcConnection | undefined {
  if (conn) return conn;
  if (connDisabledReason) return undefined;
  if (typeof process.send !== 'function') {
    connDisabledReason = 'no IPC channel from parent — mocha was not spawned with stdio "ipc"';
    process.stderr.write(`[qa-hooks] disabled: ${connDisabledReason}\n`);
    return undefined;
  }
  conn = new JsonRpcConnection(nodeIpcTransport(process));
  // Node's IPC channel keeps the event loop alive even after all tests finish.
  // Unref it so mocha can exit naturally once the test suite + reporter complete.
  // The connection remains usable during the run; only its "pin the loop" effect is released.
  const ch = (process as unknown as { channel?: { unref?: () => void } }).channel;
  ch?.unref?.();
  return conn;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'NonError', message: String(err) };
}

function fileLineFromStack(stack: string | undefined): number | null {
  if (!stack) return null;
  const m = stack.match(/:(\d+):\d+\)?$/m);
  return m ? Number(m[1]) : null;
}

// `Runnable#currentRetry()` is `protected` in @types/mocha but is the documented
// way to read a test's retry index — see the mocha "retry tests" guide and the
// `this.test.parent.retries(this.currentTest.currentRetry())` clamp idiom in
// ARCHITECTURE.md §3.1. Cast through the public Runnable shape to call it.
function currentRetryOf(test: Mocha.Test): number {
  return (test as unknown as { currentRetry: () => number }).currentRetry();
}

async function awaitDecisionWithHeartbeat(
  c: JsonRpcConnection,
  params: DecisionAwaitParams,
): Promise<DecisionResult> {
  let lastHeartbeat = Date.now();
  c.onNotification(METHOD.heartbeat, (raw) => {
    const parsed = HeartbeatParams.safeParse(raw);
    if (parsed.success && parsed.data.session_id === params.session_id) {
      lastHeartbeat = parsed.data.at;
    }
  });

  return await new Promise<DecisionResult>((resolve) => {
    let settled = false;
    const finish = (d: DecisionResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve(d);
    };

    const watchdog = setInterval(() => {
      const elapsed = Date.now() - lastHeartbeat;
      if (elapsed > MAX_MISSED_HEARTBEATS * params.heartbeat_ms) {
        finish({
          kind: 'give_up',
          reason: `abandoned (${MAX_MISSED_HEARTBEATS} heartbeats missed; ${elapsed}ms since last)`,
          by: 'hook',
        });
      }
    }, Math.max(500, Math.floor(params.heartbeat_ms / 2)));

    c.request(METHOD.decisionAwait, params, DecisionResult).then(
      (d) => finish(d),
      (err) => finish({ kind: 'give_up', reason: `ipc error: ${(err as Error).message}`, by: 'hook' }),
    );
  });
}

export const mochaHooks = {
  // No `beforeEach`: ARCHITECTURE v5 §3.1 explicitly removes `this.retries(999)`.
  // Mocha v10 retries from beforeEach mutate the hook's runnable, not the test;
  // and even if we did set retries on the test, the clone-on-retry semantics in
  // runner.js:814–823 make state mutation in afterEach unable to stop the loop.
  // Outcome translation lives in qa-reporter (§3.6); retry decisions are honored
  // by the extension respawning mocha with `--grep` (S4) or by the S2 oracle
  // simulating the same.

  async afterEach(this: Mocha.Context): Promise<void> {
    const test = this.currentTest;
    if (!test || test.state !== 'failed') return;

    const c = getConnection();
    if (!c) {
      // No IPC parent — let mocha + the built-in reporter handle the failure normally.
      return;
    }

    // v5.2 §3.1: discover via wdio singleton (Mode A) or fall back to env (Mode B).
    // Mode is determined by whether currentBrowser AND getPuppeteer succeeded.
    let cdpWsUrl: string;
    let mode: 'A' | 'B' = 'B';
    if (currentBrowser?.getPuppeteer) {
      try {
        const pup = await currentBrowser.getPuppeteer();
        if (pup?.wsEndpoint) {
          cdpWsUrl = pup.wsEndpoint();
          mode = 'A';
          // v5.3 §2.6 positive logging for Mode A engagement.
          process.stderr.write(`[qa-hooks] Mode A engaged for test="${test.title}" cdp=${cdpWsUrl}\n`);
        } else {
          cdpWsUrl = process.env.QA_DEBUG_CDP_WS_URL ?? 'ws://localhost:9222';
        }
      } catch (err) {
        process.stderr.write(
          `[qa-hooks] wdio getPuppeteer() failed: ${(err as Error).message}; falling back to QA_DEBUG_CDP_WS_URL\n`,
        );
        cdpWsUrl = process.env.QA_DEBUG_CDP_WS_URL ?? 'ws://localhost:9222';
      }
    } else {
      cdpWsUrl = process.env.QA_DEBUG_CDP_WS_URL ?? 'ws://localhost:9222';
    }
    const payload: PausePayload = {
      test: test.title,
      // v5.5 §2.4 / C1 — Mocha's Runnable.fullTitle() at runnable.js:206;
      // space-joined ancestor titles + own title. Canonical id key for
      // unifying with Test Explorer discovery.
      full_title: test.fullTitle(),
      file: test.file ?? null,
      line: fileLineFromStack(test.err?.stack),
      error: serializeError(test.err),
      cdp_ws_url: cdpWsUrl,
      mode,
      started_at: Date.now(),
      retry_count: currentRetryOf(test),
    };

    let sessionId: string;
    try {
      const result = await c.request(METHOD.pausePublish, payload, PausePublishResult);
      sessionId = result.session_id;
    } catch (err) {
      process.stderr.write(`[qa-hooks] pause.publish failed: ${(err as Error).message}\n`);
      return;
    }

    const decision = await awaitDecisionWithHeartbeat(c, {
      session_id: sessionId,
      heartbeat_ms: HEARTBEAT_MS,
      on_abandoned: 'give_up',
    });

    // Broadcast the resolved decision on two channels:
    //   (1) `inProcBus` — for the qa-reporter (same mocha process; cannot receive
    //       via process.send, which only delivers to the parent).
    //   (2) IPC `final_decision` notification — for the oracle/extension parent,
    //       so they can also log/observe the decision outcome.
    const finalDecision: FinalDecisionParams = {
      session_id: sessionId,
      kind: decision.kind,
      reason: decision.reason,
      by: decision.by,
      // v5.5 §2.4: renamed test_title → full_title (always was test.fullTitle()).
      full_title: test.fullTitle(),
      test_file: test.file ?? null,
    };
    inProcBus.emitFinalDecision(finalDecision);
    c.notify(METHOD.finalDecision, finalDecision);

    if (decision.kind === 'retry') {
      // ARCHITECTURE v5.1 §3.1: no in-process require.cache invalidation — the
      // --grep respawn runs in a fresh child process whose require.cache is empty
      // by construction. See mocha-hooks/README.md "Phase 2 follow-up" block for
      // the evidence chain and the re-add requirement if Phase 2 introduces an
      // in-process retry mechanism.
      return;
    }

    // mark_passed and give_up: hook does NOT mutate test.state / test.err /
    // parent.retries / currentTest.retries (see ARCHITECTURE v5 §3.1). The reporter
    // translates the failure event into the appropriate tri-state outcome by
    // consulting `final_decision` above.
  },
};

