/**
 * CDP download-shim — an in-process HTTP+WS proxy that sits between
 * playwright-mcp (`--cdp-endpoint`) and the real browser CDP endpoint, and
 * swallows `Browser.setDownloadBehavior`.
 *
 * Why: playwright-mcp's `--cdp-endpoint` path is `chromium.connectOverCDP()`
 * with no `noDefaults` (playwright-core `tools/mcp/browserFactory.ts`), so
 * Playwright unconditionally sends `Browser.setDownloadBehavior` during the
 * handshake (`server/chromium/crBrowser.ts` `CRBrowserContext.initialize`).
 * Browsers whose CDP lacks browser-level context management (old Electron /
 * embedded Chromium) reject it with "Browser context management is not
 * supported", failing the first `browser_*` tool call.
 *
 * This reproduces the effect of `noDefaults: true` (public since Playwright
 * v1.60) for the MCP, which exposes no way to set it. The swallow mirrors
 * playwright-mcp's own extension relay, which does exactly this:
 * `tools/mcp/cdpRelay.ts` → `case 'Browser.setDownloadBehavior': return {};`
 *
 * Scope: makes *attach* succeed. It does NOT make Playwright-managed downloads
 * work — same tradeoff as `noDefaults`. For the read-only pause-inspection flow
 * (snapshot / evaluate / screenshot) that tradeoff is irrelevant.
 *
 * See PLAN-cdp-electron-shim.md.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

/** CDP methods intercepted and answered locally with `{ result: {} }`. */
export const DEFAULT_SWALLOW_METHODS: readonly string[] = ['Browser.setDownloadBehavior'];

export interface CdpShimOptions {
  /** http root of the real CDP endpoint, e.g. `http://127.0.0.1:22135`. */
  targetHttpRoot: string;
  /** Overrides the swallow-set. Defaults to {@link DEFAULT_SWALLOW_METHODS}. */
  swallowMethods?: readonly string[];
  /** Bind host. Defaults to `127.0.0.1` (never expose off-box). */
  host?: string;
  /** Optional structured log sink. */
  log?: (msg: string) => void;
}

export interface CdpShim {
  /** http root to hand to playwright-mcp's `--cdp-endpoint`. */
  readonly httpRoot: string;
  /** Closes the server and any live bridges. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start a shim bound to `127.0.0.1:0` (OS-assigned port) proxying to
 * `targetHttpRoot`. Resolves once the server is listening.
 */
export async function startCdpDownloadShim(opts: CdpShimOptions): Promise<CdpShim> {
  const host = opts.host ?? '127.0.0.1';
  const swallow = new Set(opts.swallowMethods ?? DEFAULT_SWALLOW_METHODS);
  const log = opts.log ?? (() => {});

  const target = new URL(opts.targetHttpRoot);
  const targetHost = target.hostname;
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');

  let shimAuthority = ''; // host:port, set after listen
  const bridges = new Set<{ close(): void }>();

  // ── HTTP discovery passthrough ──────────────────────────────────────────
  // Playwright's connectOverCDP(http://...) GETs /json/version and reads
  // webSocketDebuggerUrl; we proxy the /json* family and rewrite ws authorities
  // to point back at this shim so the subsequent WS connect lands here.
  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqPath = req.url ?? '/';
    if (!reqPath.startsWith('/json')) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const upstream = await fetch(`http://${targetHost}:${targetPort}${reqPath}`);
      const text = await upstream.text();
      const body = rewriteWsAuthorities(text);
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(body);
    } catch (e) {
      log(`[cdp-shim] http proxy error for ${reqPath}: ${(e as Error).message}`);
      res.writeHead(502);
      res.end();
    }
  }

  /**
   * Rewrite `webSocketDebuggerUrl` authorities in a /json* JSON body so they
   * point at the shim (preserving path, e.g. /devtools/browser/<UUID>).
   * Non-JSON bodies pass through untouched.
   */
  function rewriteWsAuthorities(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    const rewriteOne = (obj: Record<string, unknown>): void => {
      const ws = obj.webSocketDebuggerUrl;
      if (typeof ws === 'string') {
        try {
          const u = new URL(ws);
          u.host = shimAuthority;
          obj.webSocketDebuggerUrl = u.toString();
        } catch {
          /* leave as-is */
        }
      }
    };
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry === 'object') rewriteOne(entry as Record<string, unknown>);
      }
    } else if (parsed && typeof parsed === 'object') {
      rewriteOne(parsed as Record<string, unknown>);
    }
    return JSON.stringify(parsed);
  }

  // ── WS bridge ───────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      bridgeConnection(clientWs, req.url ?? '/');
    });
  });

  function bridgeConnection(clientWs: WebSocket, reqPath: string): void {
    // The incoming path carries the (rewritten) devtools path verbatim; only
    // the authority differed, so dial the same path on the real target.
    const targetWsUrl = `ws://${targetHost}:${targetPort}${reqPath}`;
    const targetWs = new WebSocket(targetWsUrl, { perMessageDeflate: false });
    const queued: Array<{ data: RawData | string; binary: boolean }> = [];
    let disposed = false;

    const bridge = {
      close(): void {
        if (disposed) return;
        disposed = true;
        bridges.delete(bridge);
        try {
          clientWs.close();
        } catch {
          /* ignore */
        }
        try {
          targetWs.close();
        } catch {
          /* ignore */
        }
      },
    };
    bridges.add(bridge);

    targetWs.on('open', () => {
      for (const m of queued) targetWs.send(m.data);
      queued.length = 0;
    });
    targetWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });
    targetWs.on('close', () => bridge.close());
    targetWs.on('error', (e) => {
      log(`[cdp-shim] target ws error: ${(e as Error).message}`);
      bridge.close();
    });

    clientWs.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        if (trySwallow(text, clientWs)) return;
        if (targetWs.readyState === WebSocket.OPEN) targetWs.send(text);
        else queued.push({ data: text, binary: false });
        return;
      }
      if (targetWs.readyState === WebSocket.OPEN) targetWs.send(data, { binary: true });
      else queued.push({ data, binary: true });
    });
    clientWs.on('close', () => bridge.close());
    clientWs.on('error', () => bridge.close());
  }

  /**
   * If `text` is a CDP command whose method is in the swallow-set, answer it
   * locally with `{ result: {} }` (echoing id + sessionId) and return true so
   * the caller does NOT forward it. Otherwise false.
   */
  function trySwallow(text: string, clientWs: WebSocket): boolean {
    let msg: { id?: number; method?: string; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return false;
    }
    if (typeof msg.method !== 'string' || !swallow.has(msg.method)) return false;
    const resp: { id?: number; sessionId?: string; result: Record<string, never> } = {
      id: msg.id,
      result: {},
    };
    if (msg.sessionId !== undefined) resp.sessionId = msg.sessionId;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(resp));
    log(`[cdp-shim] swallowed ${msg.method} (id=${msg.id ?? '?'})`);
    return true;
  }

  // ── Listen ────────────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const shimPort = (server.address() as AddressInfo).port;
  shimAuthority = `${host}:${shimPort}`;
  const httpRoot = `http://${shimAuthority}`;
  log(`[cdp-shim] listening ${httpRoot} → ${opts.targetHttpRoot} (swallow: ${[...swallow].join(', ')})`);

  let stopped = false;
  return {
    httpRoot,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const b of [...bridges]) b.close();
      bridges.clear();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log(`[cdp-shim] stopped ${httpRoot}`);
    },
  };
}
