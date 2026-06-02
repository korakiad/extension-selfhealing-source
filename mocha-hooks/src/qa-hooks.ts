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
import { probePorts } from './probe.js';

// ---------- v5.16 — Mode C discovery ----------
// Hard-coded defaults match consumer org's framework launch convention. Overridable
// via QA_DEBUG_CDP_PORTS env (comma-separated). Hard-code accepted as transitional
// trade-off — promote to workspace setting before external distribution.
const DEFAULT_CDP_PORTS: readonly number[] = [22135, 22136] as const;

function effectiveCdpPorts(): readonly number[] {
  const env = process.env.QA_DEBUG_CDP_PORTS?.trim();
  if (!env) return DEFAULT_CDP_PORTS;
  const tokens = env.split(',').map((s) => s.trim()).filter(Boolean);
  const valid: number[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) valid.push(n);
    else invalid.push(t);
  }
  if (invalid.length > 0) {
    process.stderr.write(
      `[qa-hooks] WARN QA_DEBUG_CDP_PORTS contained invalid entries [${invalid.join(', ')}]; using valid subset [${valid.join(', ')}]\n`,
    );
  }
  return valid.length > 0 ? valid : DEFAULT_CDP_PORTS;
}

// classifyRuntime / probeChromePort / probePorts now live in ./probe (the single
// shared copy used by qa-hooks, the extension LM tools, and the stdio MCP server).

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
// Tag identifies our afterEach when it re-enters the patched
// Suite.prototype.afterEach via rootHooks (mocha.js:1082). QA_PATCH_INSTALLED
// on Suite.prototype guards against double --require of qa-hooks (the IIFE
// no-ops on the second pass). WeakSet dedupes pause.publish across the multiple
// suite levels our injected hook fires from (Mocha walks innermost-first per
// runner.js:610, AND hookErr re-enters hookUp from errSuite.parent per
// runner.js:695-718). Identity is stable within one attempt (runner.js:494).
const OUR_HOOK_TAG: unique symbol = Symbol('qa-hooks.afterEach');
const QA_PATCH_INSTALLED: unique symbol = Symbol('qa-hooks.patchInstalled');
const pausedTests = new WeakSet<Mocha.Test>();

// ---------- v5.15 Suite.prototype.afterEach monkey-patch ----------
// Mocha's hookUp (runner.js:610-619) runs afterEach innermost-first → root
// last. If a user has an afterEach in any describe block that closes the
// browser, our root mochaHooks fires too late to capture the CDP URL. Fix:
// inject our hook at _afterEach[0] of any suite where afterEach is registered,
// so we always run first.
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
  // Resolve mocha via require.main so we bind to the SAME instance the user's
  // mocha bin already loaded — the Suite.prototype._afterEach monkey-patch below
  // only takes effect if it's the exact class their runner instantiates from.
  // Bare `require('mocha')` fails in the shipped vsix because this file lives
  // under ~/.vscode/extensions/qa-debug.../ with no mocha up the parent chain.
  const { Suite } = (require.main?.require('mocha') ?? require('mocha')) as {
    Suite: typeof Mocha.Suite;
  };

  if ((Suite.prototype as unknown as Record<symbol, unknown>)[QA_PATCH_INSTALLED]) return;

  // I7 positive schema probe — instance-level _afterEach must exist as an array.
  // Hard-fails loud on mocha version drift: silent degradation gives engineers
  // a "Chrome unreachable" red herring when the pause-publish path falls back
  // to a stale Mode B endpoint.
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

  // v5.16 — parallel probe effectiveCdpPorts() per pause (shared ./probe).
  const ports = effectiveCdpPorts();
  const availableChromes = await probePorts(ports);
  const foundPorts = availableChromes.map((c) => c.port);
  const failedPorts = ports.filter((p) => !foundPorts.includes(p));
  process.stderr.write(
    `[qa-hooks] CDP discovery: effective ports [${ports.join(', ')}], found [${foundPorts.join(', ')}], failed [${failedPorts.join(', ')}]\n`,
  );
  if (availableChromes.length === 0) {
    process.stderr.write(
      `[qa-hooks] CDP discovery: WARN no chromes responded — extension and agent must askUser for ports\n`,
    );
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
    full_title: test.fullTitle(),
    file: test.file ?? null,
    line: fileLineFromStack(test.err?.stack),
    error: serializeError(test.err),
    available_chromes: availableChromes,
    selected_cdp_port: null,
    chrome_owner: 'framework',
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
    // v5.5: renamed test_title → full_title (always was test.fullTitle()).
    full_title: test.fullTitle(),
    test_file: test.file ?? null,
  };
  inProcBus.emitFinalDecision(finalDecision);
  c.notify(METHOD.finalDecision, finalDecision);

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
// Outcome translation lives in qa-reporter; retry decisions are honored
// by the extension respawning mocha with `--grep` (S4) or by the S2 oracle
// simulating the same.
export const mochaHooks = {
  afterEach: qaAfterEachImpl,
};

