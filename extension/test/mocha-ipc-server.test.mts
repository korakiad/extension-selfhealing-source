/**
 * Unit test for the per-run mocha IPC endpoint (v5.18 task-terminal mode).
 *
 * Run from the extension dir:
 *   node --import tsx test/mocha-ipc-server.test.mts
 *
 * Exercises the REAL named pipe / unix socket the way qa-hooks does: dial
 * `endpoint` with net.connect and speak NDJSON JSON-RPC. Requires
 * mocha-hooks to be built (dist/protocol.js) — `pnpm build` does that.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import net from 'node:net';

import { JsonRpcConnection, ndjsonSocketTransport } from '@qa-debug/mocha-hooks/protocol';

import { startMochaIpcServer } from '../src/mocha-ipc-server.ts';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const logs: string[] = [];
const log = (m: string): void => {
  logs.push(m);
};

/** Poll until `fn` returns non-undefined or timeout. */
async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

try {
  await check('request/response roundtrip through the per-run endpoint', async () => {
    const srv = await startMochaIpcServer(log);
    const serverConn = new JsonRpcConnection(srv.transport);
    serverConn.handle('pause.publish', () => ({ session_id: 'sess-ipc' }));

    assert.equal(srv.connected(), false);
    const clientSock = net.connect(srv.endpoint);
    const clientConn = new JsonRpcConnection(ndjsonSocketTransport(clientSock));
    const result = await clientConn.request('pause.publish', { test: 'x' });
    assert.deepEqual(result, { session_id: 'sess-ipc' });
    assert.equal(srv.connected(), true);

    clientSock.destroy();
    await srv.dispose();
  });

  await check('sends issued before the child dials in are queued and flushed on accept', async () => {
    const srv = await startMochaIpcServer(log);
    const serverConn = new JsonRpcConnection(srv.transport);
    // Heartbeat-style notification fired while nothing is connected yet.
    serverConn.notify('heartbeat', { session_id: 's1', at: 123 });

    const got: unknown[] = [];
    const clientSock = net.connect(srv.endpoint);
    const clientConn = new JsonRpcConnection(ndjsonSocketTransport(clientSock));
    clientConn.onNotification('heartbeat', (p) => got.push(p));

    await until(() => (got.length > 0 ? true : undefined));
    assert.deepEqual(got, [{ session_id: 's1', at: 123 }]);

    clientSock.destroy();
    await srv.dispose();
  });

  await check('single-client policy: a second connection is destroyed on arrival', async () => {
    const srv = await startMochaIpcServer(log);
    const first = net.connect(srv.endpoint);
    await new Promise<void>((r) => first.once('connect', r));
    await until(() => (srv.connected() ? true : undefined));

    const second = net.connect(srv.endpoint);
    let secondClosed = false;
    second.on('close', () => {
      secondClosed = true;
    });
    second.on('error', () => {
      /* RST from destroy() is fine */
    });
    await until(() => (secondClosed ? true : undefined));
    assert.ok(logs.some((l) => l.includes('single-client policy')));

    first.destroy();
    await srv.dispose();
  });

  await check('dispose removes the POSIX socket dir, refuses new dials, drops later sends', async () => {
    const srv = await startMochaIpcServer(log);
    await srv.dispose();
    await srv.dispose(); // idempotent

    if (process.platform !== 'win32') {
      assert.equal(existsSync(srv.endpoint), false);
    }
    // Sends after dispose are dropped, not thrown.
    srv.transport.send({ jsonrpc: '2.0', method: 'noop' });

    const dial = net.connect(srv.endpoint);
    const failed = await new Promise<boolean>((resolve) => {
      dial.once('error', () => resolve(true));
      dial.once('connect', () => resolve(false));
    });
    dial.destroy();
    assert.equal(failed, true);
  });

  console.log(`\nmocha-ipc-server unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nmocha-ipc-server unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
