#!/usr/bin/env node
// E2E for the v5.18 task-terminal IPC mode — the socket-flavored sibling of
// oracle.ts. Spawns REAL mocha against the fixture tests WITHOUT any stdio
// 'ipc' entry (exactly the parenthood a VS Code task terminal gives us: none),
// hands it QA_DEBUG_IPC_ENDPOINT, and verifies:
//
//   1. qa-hooks dials back over the unix socket / named pipe and publishes
//      pauses through the NDJSON JSON-RPC transport;
//   2. decision.await round-trips (mark_passed for the first pause, give_up
//      after) and final_decision notifications arrive for every pause;
//   3. the mocha process EXITS NATURALLY once the suite + reporter complete —
//      the load-bearing check for qa-hooks' socket unref()/ref() dance (a
//      ref'd socket would hang the child forever; an unref'd one mid-pause
//      would let the loop drain and kill the child mid-await).
//
// Run from the repo root (mocha-hooks must be built):
//   node --import tsx tools/socket-e2e.ts

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { join, resolve } from 'node:path';

import {
  DecisionAwaitParams,
  DecisionResult,
  FinalDecisionParams,
  JsonRpcConnection,
  METHOD,
  PausePayload,
  PausePublishResult,
  ndjsonSocketTransport,
} from '../mocha-hooks/src/protocol.js';

const REPO = resolve(__dirname, '..');
const CWD = resolve(REPO, 'fixture-tests');
const OVERALL_TIMEOUT_MS = 60_000;

function resolveMochaBin(cwd: string): string {
  const candidates = [
    resolve(cwd, 'node_modules', '.bin', 'mocha'),
    resolve(cwd, '..', 'node_modules', '.bin', 'mocha'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`socket-e2e: cannot find mocha binary near ${cwd}`);
}

function fail(msg: string): never {
  console.error(`\nsocket-e2e FAILED ❌ — ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // ---- per-run endpoint, same construction as extension/src/mocha-ipc-server.ts
  let endpoint: string;
  let socketDir: string | undefined;
  if (process.platform === 'win32') {
    endpoint = `\\\\.\\pipe\\qa-debug-socket-e2e-${randomUUID()}`;
  } else {
    socketDir = mkdtempSync(join(os.tmpdir(), 'qa-debug-socket-e2e-'));
    endpoint = join(socketDir, 'mocha.sock');
  }

  let pauseCount = 0;
  const finalDecisions: FinalDecisionParams[] = [];
  const sessions = new Map<string, number>();

  const server = net.createServer((socket) => {
    const conn = new JsonRpcConnection(ndjsonSocketTransport(socket));
    conn.handle(METHOD.pausePublish, (raw) => {
      const payload = PausePayload.parse(raw);
      const sessionId = `e2e-${randomUUID()}`;
      sessions.set(sessionId, pauseCount++);
      console.log(`[socket-e2e] pause #${sessions.get(sessionId)} test="${payload.test}"`);
      const result: PausePublishResult = { session_id: sessionId };
      return result;
    });
    conn.handle(METHOD.decisionAwait, async (raw) => {
      const params = DecisionAwaitParams.parse(raw);
      const idx = sessions.get(params.session_id);
      if (idx === undefined) throw new Error(`SESSION_NOT_FOUND: ${params.session_id}`);
      const interval = setInterval(() => {
        conn.notify(METHOD.heartbeat, { session_id: params.session_id, at: Date.now() });
      }, params.heartbeat_ms);
      try {
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        clearInterval(interval);
      }
      const result: DecisionResult = {
        kind: idx === 0 ? 'mark_passed' : 'give_up',
        reason: `socket-e2e scripted decision #${idx}`,
        by: 'agent',
      };
      console.log(`[socket-e2e] decision #${idx} → ${result.kind}`);
      return result;
    });
    conn.onNotification(METHOD.finalDecision, (raw) => {
      finalDecisions.push(FinalDecisionParams.parse(raw));
    });
  });
  await new Promise<void>((r) => server.listen(endpoint, r));

  // ---- spawn mocha the task-terminal way: NO 'ipc' stdio entry, env only.
  const mochaBin = resolveMochaBin(CWD);
  console.log(`[socket-e2e] spawning ${mochaBin} (endpoint=${endpoint})`);
  const child = spawn(mochaBin, ['specs/**/*.spec.js'], {
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, QA_DEBUG_IPC_ENDPOINT: endpoint },
  });
  let stdout = '';
  child.stdout!.on('data', (d: Buffer) => {
    stdout += d.toString('utf8');
  });

  const watchdog = setTimeout(() => {
    child.kill('SIGKILL');
    fail(
      `mocha did not exit within ${OVERALL_TIMEOUT_MS}ms — likely the socket is pinning ` +
        `the event loop (unref regression) or a decision never resolved`,
    );
  }, OVERALL_TIMEOUT_MS);

  const exitCode: number | null = await new Promise((r) => child.on('exit', (code) => r(code)));
  clearTimeout(watchdog);
  server.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });

  // ---- assertions
  if (pauseCount < 1) fail('no pause.publish ever arrived over the socket');
  if (finalDecisions.length !== pauseCount) {
    fail(`final_decision count ${finalDecisions.length} != pause count ${pauseCount}`);
  }
  if (finalDecisions[0].kind !== 'mark_passed') {
    fail(`first final_decision was ${finalDecisions[0].kind}, expected mark_passed`);
  }
  if (!/marked-passed/.test(stdout)) {
    fail('qa-reporter stdout has no marked-passed rendering — decision did not reach the reporter');
  }
  if (exitCode === null) fail('mocha was killed by a signal instead of exiting');

  console.log(
    `\nsocket-e2e PASSED ✅  (${pauseCount} pauses, ${finalDecisions.length} final_decisions, ` +
      `natural exit code=${exitCode})`,
  );
  process.exit(0);
}

main().catch((err) => {
  fail((err as Error).stack ?? String(err));
});
