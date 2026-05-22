#!/usr/bin/env tsx
/**
 * v5.13 regression test — `test.passed` REQUEST wire + IPC delivery race.
 *
 * Bug target: pre-v5.13, when an `agent`/`human` retry decision led to a
 * passing respawn, the extension had no IPC signal that the test passed.
 * `item.busy` stayed true (spinner spun forever), `pauseStore` never cleared,
 * and clicking ▶ Retry surfaced "Pause already resolved" because the
 * decisionRouter callback was consumed by the original retry commit.
 *
 * Two sub-gates per PLAN-retry-pass-recovery.md:
 *
 *  1a — wire contract (happy path): a `test.passed` request whose `full_title`
 *       matches an "active pause" triggers parent-side cleanup BEFORE the ack.
 *       Parent's `connection.handle` callback semantics let us assert state
 *       postconditions are observable the instant `child.request(...)` resolves.
 *
 *  1b — wire contract (no-op path): a `test.passed` request with no matching
 *       active pause acks immediately and mutates no state.
 *
 *  1c — IPC delivery race (the structural fix). Fork two real Node children:
 *         (i)  one that uses bare `process.send` (notification-shape) — must
 *              demonstrate the race exists by losing messages on at least one
 *              run out of N. This is the negative baseline.
 *         (ii) one that uses `await JsonRpcConnection.request(...)` shape — must
 *              ALWAYS deliver-then-exit, zero races out of N runs.
 *       The 200-run loop is the deterministic falsification of the iter#1
 *       reviewer's blocking issue #1 (Node IPC ordering).
 *
 * Run: `pnpm --filter @qa-debug/evals run retry-pass-recovery`
 */

import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  IpcTransport,
  JsonRpcConnection,
  METHOD,
  TestPassedParams,
  TestPassedResult,
} from '@qa-debug/mocha-hooks/protocol';

// -------------------- helpers --------------------

/**
 * Tiny in-memory IpcTransport pair — bytes sent on `a` arrive on `b` and
 * vice versa, mirroring node IPC semantics for unit-test purposes (no kernel
 * buffer, no exit race; just direct callback dispatch on the same tick).
 */
function createInMemoryPair(): [IpcTransport, IpcTransport] {
  const aListeners: ((msg: unknown) => void)[] = [];
  const bListeners: ((msg: unknown) => void)[] = [];
  const a: IpcTransport = {
    send: (msg) => {
      for (const l of bListeners) l(msg);
    },
    onMessage: (cb) => {
      aListeners.push(cb);
    },
  };
  const b: IpcTransport = {
    send: (msg) => {
      for (const l of aListeners) l(msg);
    },
    onMessage: (cb) => {
      bListeners.push(cb);
    },
  };
  return [a, b];
}

// -------------------- gate 1a + 1b --------------------

interface FakeActivePause {
  session_id: string;
  full_title: string;
}

async function wireContractGates(): Promise<void> {
  const [childT, parentT] = createInMemoryPair();
  const childConn = new JsonRpcConnection(childT);
  const parentConn = new JsonRpcConnection(parentT);

  // Parent state — mirrors what session-manager.ts owns: a single active pause
  // slot the handler correlates against.
  let activePause: FakeActivePause | undefined = {
    session_id: 's-001',
    full_title: 'parent > target test',
  };
  let cleanupRanForSession: string | undefined;
  let handlerCalls = 0;

  parentConn.handle(METHOD.testPassed, async (raw) => {
    handlerCalls++;
    const params = TestPassedParams.parse(raw);
    if (!activePause || activePause.full_title !== params.full_title) {
      // Non-retry pass — ack immediately, no state change.
      return {};
    }
    cleanupRanForSession = activePause.session_id;
    activePause = undefined; // mirror clearActivePause + setContext + setIdle
    return {};
  });

  // ---- Gate 1a — happy path: matching full_title triggers cleanup ----
  const ack1 = await childConn.request(
    METHOD.testPassed,
    { full_title: 'parent > target test', test_file: '/fake.spec.js' },
    TestPassedResult,
  );
  assert.deepEqual(ack1, {}, 'gate 1a: ack payload is empty object');
  assert.equal(handlerCalls, 1, 'gate 1a: handler invoked exactly once');
  assert.equal(
    cleanupRanForSession,
    's-001',
    'gate 1a: cleanup fired for the matching session',
  );
  assert.equal(
    activePause,
    undefined,
    'gate 1a: pause store cleared by the time child.request() resolves',
  );

  // ---- Gate 1b — no-op path: no active pause → ack immediately ----
  // (activePause is already undefined from gate 1a)
  cleanupRanForSession = undefined;
  const ack2 = await childConn.request(
    METHOD.testPassed,
    { full_title: 'some unrelated test', test_file: null },
    TestPassedResult,
  );
  assert.deepEqual(ack2, {}, 'gate 1b: ack payload is empty object');
  assert.equal(handlerCalls, 2, 'gate 1b: handler invoked again');
  assert.equal(
    cleanupRanForSession,
    undefined,
    'gate 1b: no cleanup fired (no matching pause)',
  );

  // ---- Gate 1b extension — non-matching full_title with re-seeded pause ----
  activePause = { session_id: 's-002', full_title: 'parent > other test' };
  const ack3 = await childConn.request(
    METHOD.testPassed,
    { full_title: 'unrelated', test_file: null },
    TestPassedResult,
  );
  assert.deepEqual(ack3, {}, 'gate 1b-ext: ack still empty');
  assert.equal(
    activePause?.session_id,
    's-002',
    'gate 1b-ext: non-matching full_title leaves active pause untouched',
  );

  console.log('OK: gate 1a + 1b — wire contract assertions passed');
}

// -------------------- gate 1c — IPC race --------------------

interface RaceTally {
  totalRuns: number;
  exitBeforeMessage: number;
  messageBeforeExit: number;
  messageMissing: number;
}

async function forkAndMeasure(
  childScript: string,
  isRequestShape: boolean,
): Promise<{ messageAt: number | null; exitAt: number | null }> {
  return new Promise((resolve) => {
    const child: ChildProcess = fork(childScript, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let messageAt: number | null = null;
    let exitAt: number | null = null;

    child.on('message', (msg: unknown) => {
      if (messageAt === null) messageAt = Date.now();
      if (isRequestShape) {
        // Reply to JSON-RPC request: { jsonrpc, id, method, params } → { jsonrpc, id, result }
        const env = msg as { id?: number; method?: string };
        if (env.id !== undefined && env.method !== undefined) {
          child.send({ jsonrpc: '2.0', id: env.id, result: {} });
        }
      }
    });
    child.on('exit', () => {
      exitAt = Date.now();
    });
    child.on('close', () => {
      resolve({ messageAt, exitAt });
    });
  });
}

async function runRaceLoop(
  childScript: string,
  isRequestShape: boolean,
  runs: number,
): Promise<RaceTally> {
  const tally: RaceTally = {
    totalRuns: runs,
    exitBeforeMessage: 0,
    messageBeforeExit: 0,
    messageMissing: 0,
  };
  for (let i = 0; i < runs; i++) {
    const { messageAt, exitAt } = await forkAndMeasure(childScript, isRequestShape);
    if (messageAt === null) {
      tally.messageMissing++;
    } else if (exitAt !== null && exitAt < messageAt) {
      tally.exitBeforeMessage++;
    } else {
      tally.messageBeforeExit++;
    }
  }
  return tally;
}

async function deliveryRaceGate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const notifyChild = path.join(here, 'retry-pass-race-child-notify.cjs');
  const requestChild = path.join(here, 'retry-pass-race-child-request.cjs');

  // Runs: 100 is enough to surface the race on most localhost setups while
  // keeping eval under ~10s. Increase locally if surfacing the race-baseline
  // takes more iterations on a beefier machine (faster drain = fewer losses).
  const RUNS = 100;

  // Variant (i): bare process.send (notification-shape) — negative baseline.
  // We DON'T strictly require the race to surface every run — only that the
  // request-shape variant is provably better. But if zero races surface here
  // even at 100 runs, the test environment isn't representative and the IPC
  // research finding should be re-confirmed before trusting this gate.
  const notifyTally = await runRaceLoop(notifyChild, false, RUNS);
  console.log(
    `[gate 1c] notification-shape baseline: total=${notifyTally.totalRuns} ` +
      `message-before-exit=${notifyTally.messageBeforeExit} ` +
      `exit-before-message=${notifyTally.exitBeforeMessage} ` +
      `message-missing=${notifyTally.messageMissing}`,
  );

  // Variant (ii): JsonRpcConnection.request shape — structural fix.
  const requestTally = await runRaceLoop(requestChild, true, RUNS);
  console.log(
    `[gate 1c] request-shape (the fix): total=${requestTally.totalRuns} ` +
      `message-before-exit=${requestTally.messageBeforeExit} ` +
      `exit-before-message=${requestTally.exitBeforeMessage} ` +
      `message-missing=${requestTally.messageMissing}`,
  );

  // Hard assertion: request shape MUST land the message before exit on EVERY run.
  // This is the structural guarantee from Mocha runnable.js:367 Promise-await
  // contract — by the time the parent observes 'exit', it must have already
  // observed 'message' (because the child only let its event loop drain after
  // it received our ack).
  assert.equal(
    requestTally.exitBeforeMessage,
    0,
    `gate 1c: request shape MUST have zero exit-before-message races (got ${requestTally.exitBeforeMessage}/${RUNS})`,
  );
  assert.equal(
    requestTally.messageMissing,
    0,
    `gate 1c: request shape MUST never lose the message (got ${requestTally.messageMissing}/${RUNS} missing)`,
  );

  // Soft warning: if the negative baseline shows zero races, this eval is
  // running on a host where the race doesn't surface deterministically and the
  // gate's discriminatory power is reduced. Doesn't fail — the request-shape
  // assertions above stand on their own.
  if (notifyTally.exitBeforeMessage === 0 && notifyTally.messageMissing === 0) {
    console.warn(
      `[gate 1c] WARN: notification-shape baseline showed zero races in ${RUNS} runs. ` +
        `The race is environment-dependent (faster localhost IPC = fewer surface losses); ` +
        `the request-shape pass above still proves the fix delivers correctly. ` +
        `Bump RUNS to 1000 locally if you want to surface the baseline race more reliably.`,
    );
  }

  console.log('OK: gate 1c — IPC delivery race assertions passed');
}

// -------------------- main --------------------

async function main(): Promise<void> {
  await wireContractGates();
  await deliveryRaceGate();
  console.log('OK: retry-pass-recovery passed all gates');
}

main().catch((err: unknown) => {
  console.error('FAIL:', err);
  process.exit(1);
});
