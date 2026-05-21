// IPC protocol shared by the mocha-side hook (qa-hooks.cjs), the fake oracle (tools/oracle.ts),
// the qa-debug MCP server (S3), and the VS Code extension (S4).
//
// Wire shape: JSON-RPC 2.0 envelopes carried by Node's built-in `ipc` channel
// (parent spawns child with `stdio: [..., 'ipc']`; both ends use `process.send` / `process.on('message')`).
// See mocha-hooks/README.md for the rationale (vs. fd-3-NDJSON, vs. stdin/stdout).

import { z } from 'zod';

// ---------- Payload schemas ----------

export const SerializedError = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});
export type SerializedError = z.infer<typeof SerializedError>;

export const BrowserOwnershipMode = z.enum(['A', 'B']);
export type BrowserOwnershipMode = z.infer<typeof BrowserOwnershipMode>;

export const PausePayload = z.object({
  test: z.string(),
  // v5.5 §2.4: Mocha's currentTest.fullTitle() — space-joined ancestor titles
  // + own title (runnable.js:206). This is the canonical id key for unifying
  // discovery-time TestItems with pause-time TestItems (CR §3.8.1). Required;
  // Phase 1 has no released consumers outside the in-repo qa-hooks/oracle/extension.
  full_title: z.string(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  error: SerializedError,
  cdp_ws_url: z.string(),
  // v5.2 §2.4: which mode owns the browser this pause is investigating.
  // Mode A = wdio.remote() in user test code (user owns lifecycle; qa_propose_
  // close_browser declines per §2.6). Mode B = companion-launched :9222
  // (companion owns lifecycle; commit semantics unchanged). Defaults to 'B'
  // for backward compatibility with pre-v5.2 oracles / hooks that don't set
  // it explicitly (the field is optional on the wire, normalized to 'B').
  mode: BrowserOwnershipMode.optional().default('B'),
  started_at: z.number().int(),
  retry_count: z.number().int().nonnegative(),
});
export type PausePayload = z.infer<typeof PausePayload>;

export const PausePublishResult = z.object({
  session_id: z.string(),
});
export type PausePublishResult = z.infer<typeof PausePublishResult>;

export const DecisionKind = z.enum(['retry', 'mark_passed', 'give_up']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DecisionBy = z.enum(['agent', 'human', 'hook']);
export type DecisionBy = z.infer<typeof DecisionBy>;

export const DecisionAwaitParams = z.object({
  session_id: z.string(),
  heartbeat_ms: z.number().int().positive(),
  on_abandoned: z.enum(['fail', 'give_up']).default('give_up'),
});
export type DecisionAwaitParams = z.infer<typeof DecisionAwaitParams>;

export const DecisionResult = z.object({
  kind: DecisionKind,
  reason: z.string(),
  by: DecisionBy,
});
export type DecisionResult = z.infer<typeof DecisionResult>;

export const HeartbeatParams = z.object({
  session_id: z.string(),
  at: z.number().int(),
});
export type HeartbeatParams = z.infer<typeof HeartbeatParams>;

// final_decision is a notification (no response) that the hook emits to the channel
// immediately after `decision.await` resolves. The qa-reporter (subscribed via the same
// IPC channel as the oracle/extension) consumes this to render the tri-state outcome at
// EVENT_TEST_END. full_title + test_file are included so the reporter can correlate
// without a separate PauseStore lookup.
// v5.5 §2.4 / NB8: renamed `test_title` → `full_title` for symmetry with
// PausePayload.full_title. The field has always been populated with
// test.fullTitle() (qa-hooks.ts) — the rename clarifies semantics.
export const FinalDecisionParams = z.object({
  session_id: z.string(),
  kind: DecisionKind,
  reason: z.string(),
  by: DecisionBy,
  full_title: z.string(),
  test_file: z.string().nullable(),
});
export type FinalDecisionParams = z.infer<typeof FinalDecisionParams>;

// ---------- Method registry ----------

export const METHOD = {
  pausePublish: 'pause.publish',
  decisionAwait: 'decision.await',
  heartbeat: 'heartbeat',
  finalDecision: 'final_decision',
} as const;

// ---------- JSON-RPC 2.0 envelopes ----------

const JSONRPC = z.literal('2.0');
const Id = z.union([z.string(), z.number().int()]);

export const JsonRpcRequest = z.object({
  jsonrpc: JSONRPC,
  id: Id,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcNotification = z.object({
  jsonrpc: JSONRPC,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

export const JsonRpcResponse = z.object({
  jsonrpc: JSONRPC,
  id: Id,
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

export const JsonRpcEnvelope = z.union([JsonRpcRequest, JsonRpcNotification, JsonRpcResponse]);
export type JsonRpcEnvelope = z.infer<typeof JsonRpcEnvelope>;

// ---------- Connection ----------

export interface IpcTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  close?(): void;
}

type Handler = (params: unknown) => unknown | Promise<unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Handler>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private closed = false;

  constructor(private readonly transport: IpcTransport) {
    transport.onMessage((raw) => this.dispatch(raw));
  }

  request<T>(method: string, params: unknown, schema?: z.ZodType<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          if (schema) {
            const parsed = schema.safeParse(value);
            if (!parsed.success) {
              reject(new Error(`response schema mismatch for ${method}: ${parsed.error.message}`));
              return;
            }
            resolve(parsed.data);
          } else {
            resolve(value as T);
          }
        },
        reject,
      });
      const env: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.transport.send(env);
    });
  }

  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    const env: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.transport.send(env);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error('connection closed'));
    }
    this.pending.clear();
    this.transport.close?.();
  }

  private async dispatch(raw: unknown): Promise<void> {
    const parsed = JsonRpcEnvelope.safeParse(raw);
    if (!parsed.success) return; // ignore malformed
    const env = parsed.data;

    if ('id' in env && 'method' in env) {
      // request
      const handler = this.handlers.get(env.method);
      if (!handler) {
        this.transport.send({
          jsonrpc: '2.0',
          id: env.id,
          error: { code: -32601, message: `method not found: ${env.method}` },
        } satisfies JsonRpcResponse);
        return;
      }
      try {
        const result = await handler(env.params);
        this.transport.send({ jsonrpc: '2.0', id: env.id, result } satisfies JsonRpcResponse);
      } catch (err) {
        const e = err as Error;
        this.transport.send({
          jsonrpc: '2.0',
          id: env.id,
          error: { code: -32000, message: e.message, data: e.stack },
        } satisfies JsonRpcResponse);
      }
      return;
    }

    if ('id' in env && !('method' in env)) {
      // response
      const id = typeof env.id === 'number' ? env.id : Number(env.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (env.error) {
        p.reject(new Error(`${env.error.code}: ${env.error.message}`));
      } else {
        p.resolve(env.result);
      }
      return;
    }

    if ('method' in env && !('id' in env)) {
      // notification
      const h = this.notificationHandlers.get(env.method);
      h?.(env.params);
    }
  }
}

// ---------- Node-IPC transport adapters ----------

// ---------- In-process bus (hook ↔ reporter) ----------
//
// The Mocha root hook (qa-hooks.cjs) and the qa-reporter run in the SAME mocha
// child process. `process.send` sends messages to the *parent* (oracle/extension);
// it does NOT deliver to other listeners in the same process. So in-process
// hook→reporter coordination needs its own channel. A module-level EventEmitter
// suffices because both files import from this `protocol` module and therefore
// share the same singleton.

import { EventEmitter } from 'node:events';

class InProcBus extends EventEmitter {
  emitFinalDecision(params: FinalDecisionParams): void {
    this.emit(METHOD.finalDecision, params);
  }
  onFinalDecision(cb: (p: FinalDecisionParams) => void): () => void {
    this.on(METHOD.finalDecision, cb);
    return () => this.off(METHOD.finalDecision, cb);
  }
}

export const inProcBus = new InProcBus();

// Structural shape covering both `NodeJS.Process` and `child_process.ChildProcess`.
// `send` is typed loosely because Node types both ends with `Serializable` and we
// pass JSON-RPC envelopes (objects) which are serializable in practice; the cast
// avoids a forced type assertion at every call site.
export interface ChildLikeProcess {
  send?: (msg: unknown, ...rest: unknown[]) => boolean;
  on(event: 'message', cb: (msg: unknown) => void): unknown;
  disconnect?: () => void;
}

export function nodeIpcTransport(target: unknown): IpcTransport {
  const t = target as ChildLikeProcess;
  if (typeof t.send !== 'function') {
    throw new Error(
      'nodeIpcTransport: target has no .send — parent must spawn with stdio including an "ipc" entry',
    );
  }
  const listeners: ((msg: unknown) => void)[] = [];
  t.on('message', (msg) => {
    for (const l of listeners) l(msg);
  });
  return {
    send(msg) {
      t.send!(msg);
    },
    onMessage(cb) {
      listeners.push(cb);
    },
    close() {
      t.disconnect?.();
    },
  };
}
