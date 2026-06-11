/**
 * Unit test for the pause → decision lifecycle: the hook side's
 * awaitDecisionWithHeartbeat (liveness watchdog + abandon path) and the two
 * decision broadcast channels (IPC final_decision + inProcBus).
 *
 * Importing ../src/qa-hooks.ts runs the Suite#afterEach patch IIFE — mocha is a
 * devDependency here, so the patch installs against the local mocha and is inert.
 *
 * Run from the mocha-hooks dir:
 *   node --import tsx test/heartbeat.test.mts
 */
import assert from 'node:assert/strict';

import {
  DecisionAwaitParams,
  FinalDecisionParams,
  JsonRpcConnection,
  METHOD,
  PausePayload,
  inProcBus,
  type DecisionResult,
  type IpcTransport,
} from '../src/protocol.ts';
import { awaitDecisionWithHeartbeat } from '../src/qa-hooks.ts';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

function linkedTransports(): [IpcTransport, IpcTransport] {
  const aListeners: ((m: unknown) => void)[] = [];
  const bListeners: ((m: unknown) => void)[] = [];
  const deliver = (listeners: ((m: unknown) => void)[], msg: unknown): void => {
    const wire = JSON.parse(JSON.stringify(msg));
    setImmediate(() => {
      for (const l of listeners) l(wire);
    });
  };
  const a: IpcTransport = {
    send: (msg) => deliver(bListeners, msg),
    onMessage: (cb) => aListeners.push(cb),
  };
  const b: IpcTransport = {
    send: (msg) => deliver(aListeners, msg),
    onMessage: (cb) => bListeners.push(cb),
  };
  return [a, b];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

try {
  await check('decision arrives while parent heartbeats — no abandon', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);

    parent.handle(METHOD.decisionAwait, async (raw) => {
      const params = DecisionAwaitParams.parse(raw);
      const interval = setInterval(() => {
        parent.notify(METHOD.heartbeat, { session_id: params.session_id, at: Date.now() });
      }, params.heartbeat_ms);
      // Parent takes 7 heartbeat intervals to decide — well past the
      // 3-missed-heartbeat threshold if heartbeats were NOT flowing.
      await sleep(params.heartbeat_ms * 7);
      clearInterval(interval);
      const result: DecisionResult = { kind: 'mark_passed', reason: 'test decision', by: 'agent' };
      return result;
    });

    const decision = await awaitDecisionWithHeartbeat(child, {
      session_id: 'hb-happy',
      heartbeat_ms: 100,
      on_abandoned: 'give_up',
    });
    assert.equal(decision.kind, 'mark_passed');
    assert.equal(decision.by, 'agent');
  });

  await check('starved heartbeats → hook abandons with give_up', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);

    // Parent holds the request open forever and never heartbeats (the
    // crashed/quit-VS-Code scenario the watchdog exists for).
    parent.handle(METHOD.decisionAwait, () => new Promise(() => {}));

    const decision = await awaitDecisionWithHeartbeat(child, {
      session_id: 'hb-starved',
      heartbeat_ms: 100,
      on_abandoned: 'give_up',
    });
    assert.equal(decision.kind, 'give_up');
    assert.equal(decision.by, 'hook');
    assert.match(decision.reason, /abandoned/);
  });

  await check('parent-side error → hook resolves give_up (ipc error), never throws', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);
    parent.handle(METHOD.decisionAwait, () => {
      throw new Error('SESSION_NOT_FOUND: hb-err');
    });
    const decision = await awaitDecisionWithHeartbeat(child, {
      session_id: 'hb-err',
      heartbeat_ms: 100,
      on_abandoned: 'give_up',
    });
    assert.equal(decision.kind, 'give_up');
    assert.equal(decision.by, 'hook');
    assert.match(decision.reason, /ipc error/);
  });

  await check(
    'final_decision broadcast: IPC notification parses + inProcBus delivers',
    async () => {
      const [pt, ct] = linkedTransports();
      const parent = new JsonRpcConnection(pt);
      const child = new JsonRpcConnection(ct);

      const overIpc: FinalDecisionParams[] = [];
      parent.onNotification(METHOD.finalDecision, (raw) => {
        overIpc.push(FinalDecisionParams.parse(raw));
      });
      const overBus: FinalDecisionParams[] = [];
      const unsubscribe = inProcBus.onFinalDecision((p) => overBus.push(p));

      const fd: FinalDecisionParams = {
        session_id: 'fd-1',
        kind: 'give_up',
        reason: 'scripted',
        by: 'agent',
        full_title: 'suite test title',
        test_file: null,
      };
      inProcBus.emitFinalDecision(fd);
      child.notify(METHOD.finalDecision, fd);
      await sleep(20);
      unsubscribe();

      assert.deepEqual(overBus, [fd]);
      assert.deepEqual(overIpc, [fd]);
    },
  );

  await check('PausePayload schema accepts the wire shape qa-hooks publishes', () => {
    // Mirrors the payload literal in qaAfterEachImpl — guards against the
    // schema and the publisher drifting apart.
    PausePayload.parse({
      test: 't',
      full_title: 's t',
      file: null,
      line: null,
      error: { name: 'NoError', message: '(no error captured)' },
      available_chromes: [],
      selected_cdp_port: null,
      chrome_owner: 'framework',
      started_at: Date.now(),
      retry_count: 0,
    });
  });

  console.log(`\nheartbeat/decision unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nheartbeat/decision unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
