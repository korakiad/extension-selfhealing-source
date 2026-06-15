/**
 * Unit test for the IPC protocol module — wire schemas + JsonRpcConnection.
 *
 * Run from the mocha-hooks dir:
 *   node --import tsx test/protocol.test.mts
 */
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  AvailableChrome,
  DecisionAwaitParams,
  DecisionKind,
  JsonRpcConnection,
  METHOD,
  PausePayload,
  PausePublishResult,
  ndjsonSocketTransport,
  type IpcTransport,
  type NdjsonSocketLike,
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

  // ---------- ndjsonSocketTransport (v5.18 task-terminal mode) ----------

  // Hand-cranked socket so the test controls chunk boundaries exactly.
  function fakeSocket(): { socket: NdjsonSocketLike; feed(b: Buffer): void; sent: string[] } {
    const dataCbs: ((c: Buffer) => void)[] = [];
    const sent: string[] = [];
    const socket: NdjsonSocketLike = {
      write(d: string) {
        sent.push(d);
        return true;
      },
      on(_ev: 'data', cb: (c: Buffer) => void) {
        dataCbs.push(cb);
        return socket;
      },
    };
    return {
      socket,
      feed(b: Buffer) {
        for (const cb of dataCbs) cb(b);
      },
      sent,
    };
  }

  await check('ndjson framing survives a chunk split inside a multi-byte UTF-8 char', () => {
    const { socket, feed } = fakeSocket();
    const t = ndjsonSocketTransport(socket);
    const got: unknown[] = [];
    t.onMessage((m) => got.push(m));
    const title = 'ทดสอบภาษาไทย';
    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { title } })}\n`,
      'utf8',
    );
    // Split one byte INTO the first Thai char's 3-byte sequence — a per-chunk
    // toString would mangle it; StringDecoder must not.
    const splitAt = line.indexOf(Buffer.from(title, 'utf8')) + 1;
    feed(line.subarray(0, splitAt));
    assert.equal(got.length, 0); // no newline yet → nothing delivered
    feed(line.subarray(splitAt));
    assert.equal(got.length, 1);
    assert.equal((got[0] as { params: { title: string } }).params.title, title);
  });

  await check('ndjson framing delivers multiple lines per chunk and skips non-JSON noise', () => {
    const { socket, feed } = fakeSocket();
    const t = ndjsonSocketTransport(socket);
    const got: unknown[] = [];
    t.onMessage((m) => got.push(m));
    feed(Buffer.from('not json at all\n{"a":1}\n\n{"b":2}\n', 'utf8'));
    assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  });

  await check('ndjson send writes one \\n-terminated JSON line per message', () => {
    const { socket, sent } = fakeSocket();
    const t = ndjsonSocketTransport(socket);
    t.send({ jsonrpc: '2.0', method: 'y' });
    assert.deepEqual(sent, ['{"jsonrpc":"2.0","method":"y"}\n']);
  });

  await check('JSON-RPC roundtrip over a REAL local TCP socket pair', async () => {
    const server = net.createServer((sock) => {
      const c = new JsonRpcConnection(ndjsonSocketTransport(sock));
      c.handle(METHOD.pausePublish, (raw) => {
        PausePayload.parse(raw);
        return { session_id: 'sess-tcp' };
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    // Request issued straight after net.connect — exercises the same
    // write-before-connected queueing qa-hooks' getConnection relies on.
    const clientSock = net.connect(port, '127.0.0.1');
    const clientConn = new JsonRpcConnection(ndjsonSocketTransport(clientSock));
    const result = await clientConn.request(METHOD.pausePublish, validPause, PausePublishResult);
    assert.equal(result.session_id, 'sess-tcp');
    clientSock.destroy();
    server.close();
  });

  console.log(`\nprotocol unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nprotocol unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
