#!/usr/bin/env node
// Fake decision oracle for S2. Stands in for the VS Code extension:
// spawns mocha as a child with an IPC channel, responds to `pause.publish` and
// `decision.await` per a CLI-provided decision sequence, and emits heartbeats.
// Not shipped in the extension bundle. See ARCHITECTURE.md §3.1.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DecisionAwaitParams,
  DecisionKind,
  DecisionResult,
  JsonRpcConnection,
  METHOD,
  PausePayload,
  PausePublishResult,
  nodeIpcTransport,
} from '../mocha-hooks/src/protocol.js';

interface OracleArgs {
  decisions: DecisionKind[];
  cwd: string;
  testsGlob?: string;
  heartbeatMs: number;
  decisionDelayMs: number;
  /** When true, omit the next heartbeat to exercise the hook's abandoned path. */
  starvationDecisionIndex?: number;
}

function parseArgs(argv: string[]): OracleArgs {
  const args: OracleArgs = {
    decisions: ['give_up'],
    cwd: resolve(process.cwd(), 'fixture-tests'),
    heartbeatMs: 5_000,
    decisionDelayMs: 100,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--decisions':
        args.decisions = String(next).split(',').filter(Boolean) as DecisionKind[];
        i++;
        break;
      case '--cwd':
        args.cwd = resolve(String(next));
        i++;
        break;
      case '--tests':
        args.testsGlob = String(next);
        i++;
        break;
      case '--heartbeat-ms':
        args.heartbeatMs = Number(next);
        i++;
        break;
      case '--decision-delay-ms':
        args.decisionDelayMs = Number(next);
        i++;
        break;
      case '--starve-after-decision':
        args.starvationDecisionIndex = Number(next);
        i++;
        break;
      case '--help':
      case '-h':
        printHelpAndExit(0);
      default:
        process.stderr.write(`oracle: unknown arg ${a}\n`);
        printHelpAndExit(2);
    }
  }
  for (const d of args.decisions) {
    DecisionKind.parse(d);
  }
  return args;
}

function printHelpAndExit(code: number): never {
  process.stderr.write(
    `Usage: node --import tsx tools/oracle.ts \\\n` +
      `  --decisions <retry|mark_passed|give_up>[,...] \\\n` +
      `  [--cwd <dir, default fixture-tests/>] \\\n` +
      `  [--tests <glob, default from .mocharc.cjs>] \\\n` +
      `  [--heartbeat-ms <n, default 5000>] \\\n` +
      `  [--decision-delay-ms <n, default 100>] \\\n` +
      `  [--starve-after-decision <index>]    # for heartbeat-abandoned tests\n`,
  );
  process.exit(code);
}

function resolveMochaBin(cwd: string): string {
  const candidates = [
    resolve(cwd, 'node_modules', '.bin', 'mocha'),
    resolve(cwd, '..', 'node_modules', '.bin', 'mocha'),
    resolve(cwd, '..', '..', 'node_modules', '.bin', 'mocha'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`oracle: cannot find mocha binary near ${cwd}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const mochaBin = resolveMochaBin(args.cwd);

  const mochaArgs: string[] = [];
  if (args.testsGlob) mochaArgs.push(args.testsGlob);

  process.stderr.write(
    `[oracle] spawning ${mochaBin} ${mochaArgs.join(' ') || '(spec from .mocharc.cjs)'}\n` +
      `[oracle] cwd=${args.cwd} decisions=[${args.decisions.join(', ')}]\n`,
  );

  const child = spawn(mochaBin, mochaArgs, {
    cwd: args.cwd,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  const conn = new JsonRpcConnection(nodeIpcTransport(child));

  const sessions = new Map<string, { test: string; decisionIndex: number }>();
  let pauseCount = 0;

  conn.handle(METHOD.pausePublish, (raw) => {
    const payload = PausePayload.parse(raw);
    const sessionId = `s2-${randomUUID()}`;
    const idx = pauseCount++;
    sessions.set(sessionId, { test: payload.test, decisionIndex: idx });
    process.stderr.write(
      `[oracle] pause #${idx} session=${sessionId} test="${payload.test}" ` +
        `retry=${payload.retry_count} error="${payload.error.message}"\n`,
    );
    const result: PausePublishResult = { session_id: sessionId };
    return result;
  });

  conn.handle(METHOD.decisionAwait, async (raw) => {
    const params = DecisionAwaitParams.parse(raw);
    const session = sessions.get(params.session_id);
    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: ${params.session_id}`);
    }
    const decisionIndex = session.decisionIndex;
    const decisionKind: DecisionKind =
      args.decisions[decisionIndex] ?? args.decisions[args.decisions.length - 1] ?? 'give_up';

    const shouldStarve = args.starvationDecisionIndex === decisionIndex;
    if (shouldStarve) {
      process.stderr.write(`[oracle] starving heartbeats for session=${params.session_id}\n`);
      // Hold the request open without responding or heartbeating; hook must abandon.
      return await new Promise<DecisionResult>(() => {});
    }

    // Heartbeat loop while we wait for the (simulated) human/agent to decide.
    const interval = setInterval(() => {
      conn.notify(METHOD.heartbeat, { session_id: params.session_id, at: Date.now() });
    }, params.heartbeat_ms);

    try {
      await new Promise((res) => setTimeout(res, args.decisionDelayMs));
    } finally {
      clearInterval(interval);
    }
    process.stderr.write(
      `[oracle] decision session=${params.session_id} → ${decisionKind} (test="${session.test}")\n`,
    );
    const result: DecisionResult = {
      kind: decisionKind,
      reason: `oracle scripted decision #${decisionIndex}: ${decisionKind}`,
      by: 'agent',
    };
    return result;
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[oracle] mocha exited code=${code} signal=${signal ?? 'null'}\n`);
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on('error', (err) => {
    process.stderr.write(`[oracle] mocha spawn error: ${err.message}\n`);
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`[oracle] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
