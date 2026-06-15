/**
 * Per-run JSON-RPC endpoint for the mocha child running in a VS Code task
 * terminal (v5.18). The extension host is no longer the child's parent (the
 * pty host is), so Node's stdio[3] 'ipc' channel is unavailable — instead the
 * extension listens on an OS-secured local endpoint and qa-hooks dials back
 * to the path passed via the QA_DEBUG_IPC_ENDPOINT env var:
 *
 *   win32: named pipe `\\.\pipe\qa-debug-mocha-<uuid>` — the default pipe DACL
 *          only grants write (= connect, for a duplex pipe) to the creator and
 *          admins; Everyone gets read-only.
 *   POSIX: unix socket inside a fresh `mkdtemp` dir (created mode 0700) —
 *          connecting requires traversing the owner-only directory.
 *
 * Single-client policy: exactly one mocha child per run; later connections
 * (a stray parallel worker that inherited the env, anything else that found
 * the path) are destroyed on arrival.
 *
 * The exposed transport QUEUES sends issued before the child has dialed in
 * (the child connects only once qa-hooks loads), so SessionManager can build
 * its JsonRpcConnection synchronously at task-start exactly as it did around
 * the spawned child.
 *
 * vscode-free so test/mocha-ipc-server.test.mts can exercise it against real
 * sockets — same rationale as process-group-kill.ts.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { type IpcTransport, ndjsonSocketTransport } from '@qa-debug/mocha-hooks/protocol';

export interface MochaIpcServer {
  /** Value for the child's QA_DEBUG_IPC_ENDPOINT. */
  endpoint: string;
  /**
   * Bidirectional transport, usable from construction: sends issued before
   * the mocha child connects are buffered and flushed on accept.
   */
  transport: IpcTransport;
  /** True once the mocha child has dialed in. Diagnostic only. */
  connected(): boolean;
  /** Destroy the client socket, close the listener, remove the POSIX socket dir. Idempotent. */
  dispose(): Promise<void>;
}

export async function startMochaIpcServer(log: (m: string) => void): Promise<MochaIpcServer> {
  const id = randomUUID();
  let endpoint: string;
  let socketDir: string | undefined;
  if (process.platform === 'win32') {
    endpoint = `\\\\.\\pipe\\qa-debug-mocha-${id}`;
  } else {
    socketDir = mkdtempSync(path.join(os.tmpdir(), 'qa-debug-ipc-'));
    endpoint = path.join(socketDir, 'mocha.sock');
  }

  const listeners: ((msg: unknown) => void)[] = [];
  const sendQueue: unknown[] = [];
  let client: IpcTransport | undefined;
  let clientSocket: net.Socket | undefined;
  let disposed = false;

  const transport: IpcTransport = {
    send(msg) {
      // Writes after the child died (e.g. the decision.await response racing a
      // killed child) are dropped — the moral equivalent of the old benign
      // ERR_IPC_CHANNEL_CLOSED path.
      if (disposed || clientSocket?.destroyed) return;
      if (client) client.send(msg);
      else sendQueue.push(msg);
    },
    onMessage(cb) {
      listeners.push(cb);
    },
    close() {
      clientSocket?.end();
    },
  };

  const server = net.createServer((socket) => {
    if (client || disposed) {
      log('[mocha-ipc] rejected extra connection (single-client policy)');
      socket.destroy();
      return;
    }
    clientSocket = socket;
    socket.on('error', (err) => log(`[mocha-ipc] socket error: ${err.message}`));
    const t = ndjsonSocketTransport(socket);
    t.onMessage((msg) => {
      for (const l of listeners) l(msg);
    });
    client = t;
    for (const queued of sendQueue.splice(0)) t.send(queued);
    log('[mocha-ipc] mocha child connected');
  });
  server.on('error', (err) => log(`[mocha-ipc] server error: ${err.message}`));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    endpoint,
    transport,
    connected: () => client !== undefined,
    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      disposed = true;
      clientSocket?.destroy();
      return new Promise((resolve) => {
        server.close(() => {
          if (socketDir) {
            try {
              rmSync(socketDir, { recursive: true, force: true });
            } catch {
              // tmpdir leftovers are the OS's problem, not a run-blocker
            }
          }
          resolve();
        });
      });
    },
  };
}
