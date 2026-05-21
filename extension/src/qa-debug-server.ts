/**
 * In-extension qa-debug MCP host over Streamable HTTP transport.
 *
 * S4_DESIGN.md §5: VS Code launches an stdio child for playwright-mcp but the
 * extension hosts qa-debug itself, so the in-extension MementoPauseStore is
 * directly addressable from every qa_* tool handler without cross-process IPC.
 *
 * Loopback security: bind to 127.0.0.1 on an ephemeral port; require a
 * per-activation bearer token via X-Qa-Debug-Token header. The token is
 * regenerated each hostQaDebugMcp() call and never persisted (per S4_DESIGN
 * §5.2 NB#8). The auth check wraps both GET and POST per
 * @modelcontextprotocol/sdk streamableHttp.d.ts:98 verbatim
 * ("Handles an incoming HTTP request, whether GET or POST").
 *
 * Close ordering on dispose: transport.close() FIRST then httpServer.close(),
 * because the transport may still be writing to httpServer's ServerResponse
 * on open SSE streams — closing httpServer first would race the transport's
 * write into a dead socket (S4_DESIGN §5.4 [R#3-B3]).
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createQaDebugServer } from '@qa-debug/qa-debug-mcp/server';
import type { PauseStore } from '@qa-debug/pause-store-types';

import { appendInfo } from './output-channel.js';

export interface QaDebugMcpHost {
  uri: vscode.Uri;
  token: string;
  dispose: () => Promise<void>;
}

export async function hostQaDebugMcp(
  pauseStore: PauseStore,
  auditChannel: vscode.OutputChannel,
): Promise<QaDebugMcpHost> {
  const token = randomUUID();
  const mcpServer = createQaDebugServer({
    pauseStore,
    // v5.4 §2.7 — surface every tool invocation to the audit channel so
    // CR §4.5 test #4 can grep for `[qa-debug-mcp] <name> called session=...`
    // independent of whether the MCP client renders the wire-side notification.
    onInvocation: (toolName, sessionId) => {
      appendInfo(auditChannel, `[qa-debug-mcp] ${toolName} called session=${sessionId}`);
    },
  });
  // STATEFUL transport — sessionIdGenerator returns a fresh UUID per client.
  // The SDK's stateless path (sessionIdGenerator: undefined) throws on the
  // SECOND request with "Stateless transport cannot be reused across requests"
  // (webStandardStreamableHttp.js:140 in @modelcontextprotocol/sdk@1.29.0).
  // VS Code's MCP client only handshakes initialize-then-everything-else on
  // one logical session, so stateful is the right shape: initialize emits an
  // mcp-session-id header, subsequent requests include it, transport routes
  // them through the single persistent server instance. Empirically validated
  // 2026-05-21 via /tmp/probe-stateful.mjs against the same server factory.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer: HttpServer = createServer((req, res) => {
    // Auth wraps both GET and POST per streamableHttp.d.ts:98 — do NOT short-
    // circuit GET to allow SSE streaming, the token check is required for both.
    if (req.headers['x-qa-debug-token'] !== token) {
      res.statusCode = 401;
      res.end();
      return;
    }
    void transport.handleRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      appendInfo(auditChannel, `[qa-debug-server] handleRequest error: ${msg}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error(`Unexpected httpServer.address(): ${JSON.stringify(address)}`);
  }
  const uri = vscode.Uri.parse(`http://127.0.0.1:${address.port}/mcp`);
  appendInfo(auditChannel, `[qa-debug-server] listening at ${uri.toString()}`);

  return {
    uri,
    token,
    dispose: async () => {
      // S4_DESIGN §5.4 [R#3-B3]: transport first (still writing to ServerResponse),
      // then httpServer.
      try {
        await transport.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendInfo(auditChannel, `[qa-debug-server] transport.close error: ${msg}`);
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      appendInfo(auditChannel, `[qa-debug-server] disposed`);
    },
  };
}
