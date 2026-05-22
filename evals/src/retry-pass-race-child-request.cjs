// Race-test child — request shape (the structural fix).
// Mimics what `await JsonRpcConnection.request(...)` does: send a request with
// an id, await the parent's response envelope, then resolve and exit. The
// await guarantees the parent has BOTH observed the message AND replied
// before the child's event loop drains, structurally closing the IPC race.
//
// CommonJS to avoid ESM resolution complexity in the forked child.

'use strict';

if (typeof process.channel?.unref === 'function') process.channel.unref();

let nextId = 1;
const pending = new Map();

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const env = msg;
  if (env.id !== undefined && env.method === undefined) {
    // response envelope
    const p = pending.get(env.id);
    if (!p) return;
    pending.delete(env.id);
    if (env.error) {
      p.reject(new Error(`${env.error.code}: ${env.error.message}`));
    } else {
      p.resolve(env.result);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ jsonrpc: '2.0', id, method, params });
  });
}

(async () => {
  try {
    await request('test.passed', {
      full_title: 'race-child-request > pass',
      test_file: null,
    });
  } catch (err) {
    process.stderr.write(`request failed: ${err.message}\n`);
    process.exitCode = 1;
  }
  // Awaited resolution means parent acked. NOW we let the loop drain.
})();
