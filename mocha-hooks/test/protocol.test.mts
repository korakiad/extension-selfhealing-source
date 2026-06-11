/**
 * Unit test for the IPC protocol module — wire schemas + JsonRpcConnection.
 *
 * Run from the mocha-hooks dir:
 *   node --import tsx test/protocol.test.mts
 */
import assert from 'node:assert/strict';

import {
  AvailableChrome,
  DecisionAwaitParams,
  DecisionKind,
  JsonRpcConnection,
  METHOD,
  PausePayload,
  PausePublishResult,
  type IpcTransport,
} from '../src/protocol.ts';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// Two transports wired back-to-back, mimicking Node IPC: async delivery and
// JSON serialization (process.send round-trips through the structured clone /
// JSON layer, so non-serializable values must not survive).
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

const validChrome = {
  port: 22135,
  ws_url: 'ws://127.0.0.1:22135/devtools/browser/abc',
  page_titles: ['Login'],
  tab_count: 1,
  runtime: 'chrome',
};

const validPause = {
  test: 'fails because the selector resolved to no elements',
  full_title: 'selector fixture fails because the selector resolved to no elements',
  file: '/repo/specs/selector.spec.js',
  line: 12,
  error: { name: 'AssertionError', message: '0 !== 1' },
  available_chromes: [validChrome],
  selected_cdp_port: null,
  chrome_owner: 'framework',
  started_at: 1760000000000,
  retry_count: 0,
};

try {
  await check('PausePayload accepts a valid payload', () => {
    const p = PausePayload.parse(validPause);
    assert.equal(p.available_chromes[0]!.port, 22135);
  });

  await check('AvailableChrome rejects http:// ws_url, privileged port, >5 titles', () => {
    assert.throws(() =>
      AvailableChrome.parse({ ...validChrome, ws_url: 'http://127.0.0.1:22135/' }),
    );
    assert.throws(() => AvailableChrome.parse({ ...validChrome, port: 80 }));
    assert.throws(() =>
      AvailableChrome.parse({ ...validChrome, page_titles: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    );
  });

  await check('PausePayload rejects a missing error field and negative retry_count', () => {
    const { error: _error, ...withoutError } = validPause;
    assert.throws(() => PausePayload.parse(withoutError));
    assert.throws(() => PausePayload.parse({ ...validPause, retry_count: -1 }));
  });

  await check("DecisionKind is the 2-verb set — 'retry' stays removed", () => {
    DecisionKind.parse('mark_passed');
    DecisionKind.parse('give_up');
    assert.throws(() => DecisionKind.parse('retry'));
  });

  await check("DecisionAwaitParams defaults on_abandoned to 'give_up'", () => {
    const p = DecisionAwaitParams.parse({ session_id: 's1', heartbeat_ms: 5000 });
    assert.equal(p.on_abandoned, 'give_up');
  });

  await check('request → handle → response roundtrip with schema validation', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);
    parent.handle(METHOD.pausePublish, (raw) => {
      const payload = PausePayload.parse(raw);
      assert.equal(payload.test, validPause.test);
      return { session_id: 'sess-1' };
    });
    const result = await child.request(METHOD.pausePublish, validPause, PausePublishResult);
    assert.equal(result.session_id, 'sess-1');
  });

  await check('unknown method rejects with -32601', async () => {
    const [pt, ct] = linkedTransports();
    new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);
    await assert.rejects(child.request('no.such.method', {}), /-32601/);
  });

  await check('handler throw surfaces to the requester as -32000', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);
    parent.handle('boom', () => {
      throw new Error('SESSION_NOT_FOUND: nope');
    });
    await assert.rejects(child.request('boom', {}), /SESSION_NOT_FOUND/);
  });

  await check('response that fails the expected schema rejects', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);
    parent.handle(METHOD.pausePublish, () => ({ wrong_shape: true }));
    await assert.rejects(
      child.request(METHOD.pausePublish, validPause, PausePublishResult),
      /response schema mismatch/,
    );
  });

  await check('notify delivers; malformed envelopes are ignored without crashing', async () => {
    const [pt, ct] = linkedTransports();
    const parent = new JsonRpcConnection(pt);
    const child = new JsonRpcConnection(ct);
    const got: unknown[] = [];
    parent.onNotification(METHOD.heartbeat, (p) => got.push(p));
    // Garbage straight onto the wire — dispatch must ignore it.
    ct.send({ not: 'jsonrpc' });
    ct.send('garbage');
    child.notify(METHOD.heartbeat, { session_id: 's1', at: 123 });
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    assert.deepEqual(got, [{ session_id: 's1', at: 123 }]);
  });

  await check('close() rejects in-flight requests', async () => {
    const [pt, ct] = linkedTransports();
    new JsonRpcConnection(pt); // parent registers no handler → never responds in time
    const child = new JsonRpcConnection(ct);
    const inflight = child.request('never.answered', {});
    child.close();
    await assert.rejects(inflight, /connection closed/);
  });

  console.log(`\nprotocol unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nprotocol unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
