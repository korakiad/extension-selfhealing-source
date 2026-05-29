/**
 * E2E for the CDP download-shim against the REAL @playwright/mcp + REAL Chrome.
 *
 * Run from the extension dir:
 *   node --import tsx test/cdp-shim-e2e.mts
 *
 * Topology:
 *   real Chrome (headless, --remote-debugging-port)
 *     └─ "old-Electron emulator" proxy — forwards everything EXCEPT it REJECTS
 *        Browser.setDownloadBehavior with "Browser context management is not
 *        supported" (the exact failure old Electron / embedded Chromium gives).
 *
 *   NEGATIVE:  @playwright/mcp --cdp-endpoint <emulator>        → first tool MUST FAIL
 *   POSITIVE:  @playwright/mcp --cdp-endpoint <shim→emulator>   → first tool MUST SUCCEED
 *
 * Proves the shim makes the real MCP attach + drive a page through a target that
 * otherwise breaks connectOverCDP.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { startCdpDownloadShim } from '../src/cdp-download-shim.ts';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const log = (...a: unknown[]) => console.log('[e2e]', ...a);
const fail = (m: string): never => {
  console.error('[e2e] FAIL:', m);
  process.exit(1);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Real headless Chrome ────────────────────────────────────────────────────
async function launchChrome(): Promise<{ httpRoot: string; kill: () => void }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-e2e-chrome-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
    ],
    { stdio: 'ignore', detached: true }, // own process group so we can reap helpers
  );
  const killTree = () => {
    // macOS Chrome detaches its gpu/renderer/network helpers into separate
    // process groups, so kill(-pgid) misses them. The unique user-data-dir is
    // on every helper's argv → pkill -f on it reaps the whole family precisely.
    try {
      const r = spawnSync('pkill', ['-9', '-f', userDataDir]);
      log(`killTree pkill status=${r.status}`);
    } catch (e) {
      log(`killTree pkill error: ${(e as Error).message}`);
    }
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) {
        return { httpRoot: `http://127.0.0.1:${port}`, kill: killTree };
      }
    }
    await sleep(200);
  }
  killTree();
  return fail('Chrome did not expose a debug port within 20s');
}

// ─── "Old Electron" emulator: rejects Browser.setDownloadBehavior ────────────
function startElectronEmulator(targetHttpRoot: string): Promise<{ httpRoot: string; stop: () => Promise<void> }> {
  const target = new URL(targetHttpRoot);
  const targetHost = target.hostname;
  const targetPort = target.port;
  let authority = '';
  const bridges = new Set<{ close(): void }>();

  const server = http.createServer((req, res) => {
    void (async () => {
      const p = req.url ?? '/';
      if (!p.startsWith('/json')) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const up = await fetch(`http://${targetHost}:${targetPort}${p}`);
        const text = await up.text();
        let body = text;
        try {
          const j = JSON.parse(text);
          const fix = (o: any) => {
            if (o && typeof o.webSocketDebuggerUrl === 'string') {
              const u = new URL(o.webSocketDebuggerUrl);
              u.host = authority;
              o.webSocketDebuggerUrl = u.toString();
            }
          };
          Array.isArray(j) ? j.forEach(fix) : fix(j);
          body = JSON.stringify(j);
        } catch {
          /* passthrough */
        }
        res.writeHead(up.status, { 'content-type': 'application/json' });
        res.end(body);
      } catch {
        res.writeHead(502);
        res.end();
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      const t = new WebSocket(`ws://${targetHost}:${targetPort}${req.url ?? '/'}`, {
        perMessageDeflate: false,
      });
      const q: Array<RawData | string> = [];
      const bridge = {
        close() {
          try {
            client.close();
          } catch {
            /* ignore */
          }
          try {
            t.close();
          } catch {
            /* ignore */
          }
          bridges.delete(bridge);
        },
      };
      bridges.add(bridge);
      t.on('open', () => {
        for (const m of q) t.send(m);
        q.length = 0;
      });
      t.on('message', (d, b) => client.readyState === WebSocket.OPEN && client.send(d, { binary: b }));
      t.on('close', () => bridge.close());
      t.on('error', () => bridge.close());
      client.on('message', (d, b) => {
        if (!b) {
          const text = d.toString();
          try {
            const msg = JSON.parse(text);
            if (msg.method === 'Browser.setDownloadBehavior') {
              // Simulate old Electron's rejection.
              const err = {
                id: msg.id,
                ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
                error: { code: -32601, message: 'Browser context management is not supported.' },
              };
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(err));
              return;
            }
          } catch {
            /* not json, forward */
          }
          if (t.readyState === WebSocket.OPEN) t.send(text);
          else q.push(text);
          return;
        }
        if (t.readyState === WebSocket.OPEN) t.send(d, { binary: true });
        else q.push(d);
      });
      client.on('close', () => bridge.close());
      client.on('error', () => bridge.close());
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      authority = `127.0.0.1:${port}`;
      resolve({
        httpRoot: `http://${authority}`,
        stop: async () => {
          for (const b of [...bridges]) b.close();
          wss.close();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

// ─── Minimal MCP stdio client (real @playwright/mcp) ─────────────────────────
class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<number, (m: any) => void>();
  private id = 1;

  constructor(cdpEndpoint: string) {
    this.proc = spawn('npx', ['-y', '@playwright/mcp@latest', '--cdp-endpoint', cdpEndpoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (d) => this.onData(d));
    this.proc.stderr!.on('data', () => {});
  }

  private onData(d: Buffer) {
    this.buf += d.toString();
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.id && this.pending.has(obj.id)) {
        this.pending.get(obj.id)!(obj);
        this.pending.delete(obj.id);
      }
    }
  }

  private send(method: string, params: unknown, notify = false): number | undefined {
    const msg: any = { jsonrpc: '2.0', method, params };
    if (!notify) msg.id = this.id++;
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    return msg.id;
  }

  private request(method: string, params: unknown, timeoutMs = 45000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.send(method, params)!;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  async init() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.1' },
    });
    this.send('notifications/initialized', {}, true);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const res = await this.request('tools/call', { name, arguments: args });
    const text = (res.result?.content ?? [])
      .map((c: any) => c.text ?? '')
      .join('\n');
    const isError = !!res.result?.isError || !!res.error;
    const errText = res.error ? JSON.stringify(res.error) : text;
    return { isError, text: isError ? errText : text };
  }

  kill() {
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

// ─── Test content ────────────────────────────────────────────────────────────
function startContentServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>e2e</title><h1>SHIM_OK_MARKER</h1>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        stop: async () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const chrome = await launchChrome();
log('chrome at', chrome.httpRoot);
const content = await startContentServer();
log('content at', content.url);

const cleanup: Array<() => Promise<void> | void> = [chrome.kill, content.stop];
const teardown = async () => {
  // Chrome first (most important to reap), then the rest — each guarded so one
  // failure can't skip the others.
  try {
    chrome.kill();
  } catch (e) {
    log(`teardown chrome.kill error: ${(e as Error).message}`);
  }
  for (const c of cleanup.reverse()) {
    if (c === chrome.kill) continue;
    try {
      await c();
    } catch {
      /* best-effort */
    }
  }
};
process.on('exit', () => chrome.kill());

try {
  // ── NEGATIVE: MCP → emulator → chrome (must fail) ──────────────────────────
  log('\n--- NEGATIVE: direct to old-Electron emulator (expect failure) ---');
  const emu1 = await startElectronEmulator(chrome.httpRoot);
  cleanup.push(emu1.stop);
  const mcpNeg = new McpClient(emu1.httpRoot);
  cleanup.push(() => mcpNeg.kill());
  await mcpNeg.init();
  const neg = await mcpNeg.callTool('browser_navigate', { url: content.url });
  log('negative result isError=', neg.isError);
  log('negative text:', neg.text.slice(0, 200));
  if (!neg.isError) fail('NEGATIVE should have errored — emulator rejects setDownloadBehavior');
  if (!/setDownloadBehavior|context management/i.test(neg.text))
    fail(`NEGATIVE error should mention the CDP rejection, got: ${neg.text.slice(0, 300)}`);
  log('OK  negative reproduces the old-Electron failure');
  mcpNeg.kill();
  await emu1.stop();
  cleanup.pop();
  cleanup.pop();

  // ── POSITIVE: MCP → shim → emulator → chrome (must succeed) ─────────────────
  log('\n--- POSITIVE: through the download-shim (expect success) ---');
  const emu2 = await startElectronEmulator(chrome.httpRoot);
  cleanup.push(emu2.stop);
  const shim = await startCdpDownloadShim({ targetHttpRoot: emu2.httpRoot, log: (m) => log(m) });
  cleanup.push(() => shim.stop());
  const mcpPos = new McpClient(shim.httpRoot);
  cleanup.push(() => mcpPos.kill());
  await mcpPos.init();
  const nav = await mcpPos.callTool('browser_navigate', { url: content.url });
  log('positive navigate isError=', nav.isError);
  if (nav.isError) fail(`POSITIVE navigate should succeed through shim, got: ${nav.text.slice(0, 300)}`);
  const snap = await mcpPos.callTool('browser_snapshot', {});
  if (snap.isError) fail(`POSITIVE snapshot should succeed, got: ${snap.text.slice(0, 300)}`);
  if (!/SHIM_OK_MARKER/.test(nav.text + snap.text))
    fail('POSITIVE snapshot should contain page content SHIM_OK_MARKER');
  log('OK  positive: navigated + snapshotted the page through the shim');

  log('\nE2E PASSED ✅  (shim turns the failing old-Electron attach into a working one)');
  await teardown();
  process.exit(0);
} catch (e) {
  await teardown();
  fail((e as Error).message);
}
