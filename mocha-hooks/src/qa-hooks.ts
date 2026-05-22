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
  TestPassedResult,
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

// ---------- v5.15 hook-order injection state ----------
// See PLAN-hook-order-injection.md. Tag identifies our afterEach when it
// re-enters the patched Suite.prototype.afterEach via rootHooks (mocha.js:1082).
// QA_PATCH_INSTALLED on Suite.prototype guards against double --require of
// qa-hooks (the IIFE no-ops on the second pass).
// WeakSets dedupe pause.publish / test.passed across the multiple suite levels
// our injected hook fires from (Mocha walks innermost-first per runner.js:610,
// AND hookErr re-enters hookUp from errSuite.parent per runner.js:695-718).
// Identity is stable within one attempt (runner.js:494) and fresh on retry via
// test.clone() (test.js:71-83) — so retries naturally get a fresh pause.
const OUR_HOOK_TAG: unique symbol = Symbol('qa-hooks.afterEach');
const QA_PATCH_INSTALLED: unique symbol = Symbol('qa-hooks.patchInstalled');
const pausedTests = new WeakSet<Mocha.Test>();
const passedTests = new WeakSet<Mocha.Test>();

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

// ---------- v5.15 Suite.prototype.afterEach monkey-patch ----------
// Per PLAN-hook-order-injection.md §3. Mocha's hookUp (runner.js:610-619)
// runs afterEach innermost-first → root last. If a user has an afterEach in
// any describe block that closes the browser, our root mochaHooks fires too
// late to capture the CDP URL. Fix: inject our hook at _afterEach[0] of any
// suite where afterEach is registered, so we always run first.
//
// Verified invariants (mocha@10.8.2):
//   I1 mocha.js:1082 — rootHooks → this.suite.afterEach(hook) flows through us
//   I2 cli/run.js:354,370 — handleRequires before new Mocha() → patch ready in time
//   I6 suite.js:319-322 — afterEach early-returns on pending suite (length-delta guards)
//   I7 suite.js:78 — _afterEach is instance-level (probe via fresh Suite)
//   I9 nodejs/worker.js + buffered-worker-pool.js:84 — MOCHA_WORKER_ID set per worker
;(function installAfterEachOrderPatch(): void {
  // Prefer the public re-export over the deep internal path; mocha 10.x has no
  // exports map but a future minor could add one.
  const { Suite } = require('mocha') as { Suite: typeof Mocha.Suite };

  if ((Suite.prototype as unknown as Record<symbol, unknown>)[QA_PATCH_INSTALLED]) return;

  // I7 positive schema probe — instance-level _afterEach must exist as an array.
  // Hard-fails loud on mocha version drift (per PLAN Q2 resolution): silent
  // degradation gives engineers a "Chrome unreachable" red herring when the
  // pause-publish path falls back to a stale Mode B endpoint.
  const probe = new Suite('__qa_probe__');
  if (!Array.isArray((probe as unknown as { _afterEach: unknown })._afterEach)) {
    throw new Error(
      '[qa-hooks] expected Suite#_afterEach to be an array (mocha 10.x internal). ' +
        'Detected schema drift — pin mocha to ~10.8 or file an issue.',
    );
  }

  // I9 parallel-worker detect. In workers, process.send IS defined (workerpool
  // uses child_process.fork) but targets the workerpool main, NOT the extension.
  // Pause-publish would silently disappear. Skip patch + IPC entirely.
  if (process.argv.includes('--parallel') || process.env.MOCHA_WORKER_ID) {
    process.stderr.write(
      '[qa-hooks] disabled in parallel-worker context (pause protocol incompatible)\n',
    );
    (Suite.prototype as unknown as Record<symbol, unknown>)[QA_PATCH_INSTALLED] = true;
    return;
  }

  const origAfterEach = Suite.prototype.afterEach;
  Suite.prototype.afterEach = function patchedAfterEach(
    this: Mocha.Suite,
    titleOrFn: unknown,
    maybeFn?: unknown,
  ): Mocha.Suite {
    const fn = typeof titleOrFn === 'function' ? titleOrFn : maybeFn;
    const sink = this as unknown as { _afterEach: Array<{ fn?: unknown }> };

    // 1. Delegate caller's request first — preserves chainable contract,
    //    pending-suite early-return (I6), and EVENT_SUITE_ADD_HOOK_AFTER_EACH.
    const result = (origAfterEach as Function).call(this, titleOrFn, maybeFn) as Mocha.Suite;

    // 2. rootHooks (or any future direct call by us) delivering qaAfterEachImpl
    //    back through the patched prototype: it's already pushed, no inject.
    if (fn && (fn as Record<symbol, unknown>)[OUR_HOOK_TAG]) return result;

    // 3. Already injected in this suite by a prior user afterEach call.
    if (sink._afterEach.some((h) => h.fn && (h.fn as Record<symbol, unknown>)[OUR_HOOK_TAG])) {
      return result;
    }

    // 4. Inject ours, then move to index 0 — but ONLY if origAfterEach actually
    //    pushed (length-delta guard handles pending suites where it no-ops).
    const before = sink._afterEach.length;
    (origAfterEach as Function).call(this, '__qa_pause_publish__', qaAfterEachImpl);
    if (sink._afterEach.length === before + 1) {
      sink._afterEach.unshift(sink._afterEach.pop()!);
    }
    return result; // returns Suite per mocha's chainable contract
  };

  (Suite.prototype as unknown as Record<symbol, unknown>)[QA_PATCH_INSTALLED] = true;
  process.stderr.write('[qa-hooks] Suite#afterEach patched for first-position injection\n');
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
  // F5-smoke 2026-05-21: wdio v8 tests can reach afterEach with test.state==='failed'
  // but test.err === undefined (mocha's timeout fires before the async click() rejects,
  // and the captured runnable error gets cleared on the timeout path). Without
  // defensive handling, String(undefined) → "undefined" reaches the agent as the
  // failing_assertion, which is worse than admitting "no error captured".
  if (err == null) {
    return {
      name: 'NoError',
      message: '(test marked failed but Mocha did not capture an error — likely a timeout abort on an async test; check test stack/console)',
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || String(err) || '(error has empty message)',
      stack: err.stack,
    };
  }
  // Non-Error throws (e.g., wdio threw a plain object, a string, or a Promise rejection
  // with a non-Error reason). JSON-stringify what we can; fall back to String() if circular.
  let message: string;
  try {
    message = JSON.stringify(err);
  } catch {
    message = String(err);
  }
  return { name: 'NonError', message: message || '(non-Error throw with no representation)' };
}

/**
 * Normalize CDP WebSocket host so downstream clients (playwright-mcp) can connect.
 * Chrome bound to `0.0.0.0` (INADDR_ANY) reports back `ws://0.0.0.0:<port>/...` from
 * getPuppeteer().wsEndpoint(); some clients refuse `0.0.0.0` as a target. Substitute
 * the loopback address so the URL is dialable. The actual TCP socket on 0.0.0.0
 * accepts connections from 127.0.0.1 by definition.
 */
function normalizeCdpWsUrl(raw: string): string {
  return raw.replace(/^ws:\/\/0\.0\.0\.0(:|\/)/, 'ws://127.0.0.1$1');
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

// v5.15: extracted from mochaHooks.afterEach so the same body serves both
// the root mochaHooks export AND the per-suite injected copies installed by
// installAfterEachOrderPatch above. Tagged with OUR_HOOK_TAG so the wrapper
// recognizes self-delivery (rootHooks → suite.afterEach path) and skips
// re-injection.
async function qaAfterEachImpl(this: Mocha.Context): Promise<void> {
  const test = this.currentTest;
  if (!test) return;

  const c = getConnection();
  if (!c) {
    // No IPC parent — let mocha + the built-in reporter handle the outcome normally.
    return;
  }

  // v5.13 — pass branch: fire test.passed as a REQUEST (awaited) before mocha
  // advances. Mocha's runnable.js:367 `result.then(done, …)` blocks the hook
  // completion callback until this Promise resolves, which only happens after
  // the parent has read AND replied. This structurally closes the IPC exit-race
  // (Node provides no 'message'-before-'exit' invariant; mocha's exitMochaLater
  // + qa-hooks' channel.unref let the loop drain in a few ticks otherwise).
  // The parent's handler returns AFTER it has cleaned up paused-test state, so
  // there is no observable window where the extension still thinks the test
  // is paused at the moment afterEach returns. See PLAN-retry-pass-recovery.md.
  if (test.state === 'passed') {
    // v5.15 dedupe — innermost-first walk + injected hook at every suite level
    // means ancestor suites re-fire us within one attempt. WeakSet keyed on Test
    // (stable per attempt via runner.js:494; fresh per retry via test.js:71-83
    // → retries naturally get a fresh test.passed call).
    // Add BEFORE the await so a re-entry during the in-flight request returns
    // early instead of stacking duplicate requests.
    if (passedTests.has(test)) return;
    passedTests.add(test);
    try {
      await c.request(METHOD.testPassed, {
        full_title: test.fullTitle(),
        test_file: test.file ?? null,
      }, TestPassedResult);
    } catch (err) {
      // Parent disconnect or malformed reply: log and let mocha continue.
      // The cleanup gap re-emerges only if the parent crashed, in which case
      // the extension lifecycle has bigger problems than a stuck spinner.
      process.stderr.write(
        `[qa-hooks] test.passed request failed: ${(err as Error).message}\n`,
      );
    }
    return;
  }

  if (test.state !== 'failed') return;

  // v5.15 dedupe — load-bearing for two re-entry paths:
  //   (a) injected hook fires at every suite level (innermost-first walk).
  //   (b) hookErr re-enters hookUp from errSuite.parent (runner.js:695-718)
  //       when a downstream user afterEach throws AFTER ours ran.
  // Without this guard, a single failure would publish multiple pause sessions.
  if (pausedTests.has(test)) return;
  pausedTests.add(test);

  // Disable Mocha's runnable timeout for this hook. pause.publish + decision.await
  // is a blocking, human-paced flow (engineer inspects browser via CDP, decides
  // mark_passed / retry / give_up). User .mocharc timeouts of 10-15s are designed
  // for test-body assertions, not for a debugging session — leaving the timeout
  // enabled kills the hook mid-debug, tearing down the wdio session and closing
  // the browser. The real liveness watchdog is the heartbeat protocol below
  // (parent emits every HEARTBEAT_MS; hook gives up after MAX_MISSED_HEARTBEATS).
  // See Mocha docs: https://mochajs.org/#timeouts ("To disable timeouts ... pass 0").
  this.timeout(0);

  // v5.2 §3.1: discover via wdio singleton (Mode A) or fall back to env (Mode B).
  // Mode is determined by whether currentBrowser AND getPuppeteer succeeded.
  let cdpWsUrl: string;
  let mode: 'A' | 'B' = 'B';
  if (currentBrowser?.getPuppeteer) {
    try {
      const pup = await currentBrowser.getPuppeteer();
      if (pup?.wsEndpoint) {
        cdpWsUrl = normalizeCdpWsUrl(pup.wsEndpoint());
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
  // v5.8 — defensive diagnostic for unreachable-in-normal-flow cases.
  // Post-qa-reporter-fix (v5.8 EVENT_TEST_FAIL handler), test.err should
  // always be set when state==='failed' because Runner.fail wraps non-Error
  // throws via thrown2Error (runner.js:442) before emitting EVENT_TEST_FAIL.
  // Remaining cases this WARN catches: (a) third-party code emits
  // EVENT_TEST_FAIL directly bypassing Runner.fail; (b) reporter regression
  // removes the assignment; (c) Runner#uncaught paths that don't go through
  // standard fail emission.
  if (test.err == null) {
    process.stderr.write(
      `[qa-hooks] WARN test marked failed but test.err is ${typeof test.err}=${String(test.err)} — ` +
        `Mocha's Runner.fail does NOT set test.err; the active reporter is expected to. ` +
        `qa-reporter (v5.8+) replicates the Base reporter assignment. ` +
        `If you see this WARN, either the reporter changed, OR the test was failed via a path that bypasses EVENT_TEST_FAIL.\n`,
    );
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
}
;(qaAfterEachImpl as unknown as Record<symbol, unknown>)[OUR_HOOK_TAG] = true;

// v5.15: root mochaHooks export delegates to the same extracted body. Mocha's
// rootHooks plugin loader (mocha.js:1082) re-enters Suite.prototype.afterEach,
// which our installAfterEachOrderPatch wrapper recognizes via OUR_HOOK_TAG and
// short-circuits (no re-injection on root). Defence-in-depth — covers the case
// where the user has NO afterEach anywhere (patch never fires for that path).
//
// No `beforeEach`: ARCHITECTURE v5 §3.1 explicitly removes `this.retries(999)`.
// Mocha v10 retries from beforeEach mutate the hook's runnable, not the test;
// and even if we did set retries on the test, the clone-on-retry semantics in
// runner.js:814–823 make state mutation in afterEach unable to stop the loop.
// Outcome translation lives in qa-reporter (§3.6); retry decisions are honored
// by the extension respawning mocha with `--grep` (S4) or by the S2 oracle
// simulating the same.
export const mochaHooks = {
  afterEach: qaAfterEachImpl,
};

