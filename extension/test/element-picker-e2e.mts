/**
 * E2E for the rewritten element picker against REAL Chrome.
 *
 * Run from the extension dir:
 *   node --import tsx test/element-picker-e2e.mts
 *
 * Topology: headless Chrome on a hostile test page (duplicate ids, open shadow
 * DOM, same-origin iframe, cross-origin OOPIF via a second origin +
 * --site-per-process, canvas). A second CDP client simulates the QA's click
 * with Input.dispatchMouseEvent while pickElement() is armed — synthetic
 * browser-process input drives Overlay.inspectNodeRequested exactly like a
 * human click.
 *
 * Proves, per surface:
 *  - candidates carry LIVE matchCounts (button#container ×3 reported as 3)
 *  - uniquePath verifiably matches exactly one node
 *  - the data-qa-pick marker lands on the clicked element (incl. shadow/iframe)
 *  - computed role/accessibleName arrive (browser_snapshot vocabulary)
 *  - frameChain resolves for same-origin AND cross-origin (OOPIF) frames
 *  - rect arrives for canvas surfaces
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket, type RawData } from 'ws';

import { pickElement, resolvePageWsUrl, type PickResult } from '../src/element-picker.ts';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const log = (...a: unknown[]) => console.log('[picker-e2e]', ...a);
const fail = (m: string): never => {
  console.error('[picker-e2e] FAIL:', m);
  process.exit(1);
};
const assert = (cond: unknown, m: string) => {
  if (!cond) fail(m);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Content servers (two origins: 127.0.0.1 = main, localhost = cross) ─────
function serve(pages: Record<string, string>): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({
        port: (server.address() as any).port,
        stop: async () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const CROSS_PAGE = `<!doctype html><html><body style="margin:0">
<button id="container" aria-label="Cross button" style="width:100%;height:96px;margin:0">X</button>
</body></html>`;

const CHILD_PAGE = `<!doctype html><html><body style="margin:0">
<button id="container" aria-label="Frame button" style="width:100%;height:96px;margin:0">F</button>
</body></html>`;

function indexPage(crossOrigin: string): string {
  return `<!doctype html><html><body style="margin:8px">
<div id="legend">
  <div class="row"><button id="container" class="legend-btn">A</button></div>
  <div class="row"><button id="container" class="legend-btn" aria-label="Add comparison">B</button></div>
  <div class="row"><button id="container" class="legend-btn">C</button></div>
</div>
<div id="shadow-host"></div>
<iframe id="child-frame" src="/child.html" style="display:block;width:280px;height:100px;border:0"></iframe>
<iframe id="xorigin-frame" src="${crossOrigin}/cross.html" style="display:block;width:280px;height:100px;border:0"></iframe>
<canvas id="chart" width="200" height="80" style="display:block;background:#eee"></canvas>
<script>
  document.getElementById('shadow-host')
    .attachShadow({ mode: 'open' })
    .innerHTML = '<button class="inner-btn" aria-label="Shadow button">S</button>';
</script>
</body></html>`;
}

// ─── Real headless Chrome (cdp-shim-e2e launch/teardown pattern) ─────────────
async function launchChrome(startUrl: string): Promise<{ httpRoot: string; kill: () => void }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-e2e-chrome-'));
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
      '--site-per-process', // force the cross-origin iframe into an OOPIF
      '--window-size=900,800',
      startUrl,
    ],
    { stdio: 'ignore', detached: true },
  );
  const killTree = () => {
    try {
      spawnSync('pkill', ['-9', '-f', userDataDir]);
    } catch {
      /* ignore */
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
      if (port) return { httpRoot: `http://127.0.0.1:${port}`, kill: killTree };
    }
    await sleep(200);
  }
  killTree();
  return fail('Chrome did not expose a debug port within 20s');
}

// ─── Minimal raw-CDP "QA hand": evaluates coords + dispatches real clicks ────
class CdpHand {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }

  static async connect(pageWsUrl: string): Promise<CdpHand> {
    const ws = new WebSocket(pageWsUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e: Error) => reject(e));
    });
    return new CdpHand(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the top document; must JSON-serialize. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(`eval threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r?.result?.value as T;
  }

  async click(x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Arm the picker, then click (retrying — OOPIF sessions arm async) until it resolves. */
async function pickWithClick(
  browserWsUrl: string,
  hand: CdpHand,
  pointExpr: string,
): Promise<PickResult> {
  const p = pickElement(browserWsUrl, { timeoutMs: 30000, log: (m) => log(m) });
  let settled = false;
  const tracked = p.then(
    (v) => ((settled = true), v),
    (e) => {
      settled = true;
      throw e;
    },
  );
  await sleep(1200); // let the root session (and auto-attached OOPIFs) arm
  for (let i = 0; i < 6 && !settled; i++) {
    const pt = await hand.eval<{ x: number; y: number }>(pointExpr);
    await hand.click(Math.round(pt.x), Math.round(pt.y));
    await sleep(900);
  }
  return tracked;
}

const center = (rectExpr: string) =>
  `(() => { const r = ${rectExpr}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

// ─── Run ─────────────────────────────────────────────────────────────────────
const crossSrv = await serve({ '/cross.html': CROSS_PAGE });
const crossOrigin = `http://localhost:${crossSrv.port}`;
const mainSrv = await serve({ '/': indexPage(crossOrigin), '/child.html': CHILD_PAGE });
const mainUrl = `http://127.0.0.1:${mainSrv.port}/`;
log('content at', mainUrl, '· cross-origin at', crossOrigin);

const chrome = await launchChrome(mainUrl);
log('chrome at', chrome.httpRoot);
process.on('exit', () => chrome.kill());

const teardown = async () => {
  chrome.kill();
  await mainSrv.stop().catch(() => {});
  await crossSrv.stop().catch(() => {});
};

try {
  // The picker resolves its own page target from the browser ws URL; it only
  // uses the http authority, so the /json/version browser ws is fine.
  const version = await (await fetch(`${chrome.httpRoot}/json/version`)).json();
  const browserWsUrl: string = version.webSocketDebuggerUrl;
  const pageWsUrl = await resolvePageWsUrl(chrome.httpRoot);
  const hand = await CdpHand.connect(pageWsUrl);

  // Wait for the page (and subframes) to load.
  const loadDeadline = Date.now() + 15000;
  while (Date.now() < loadDeadline) {
    const ready = await hand
      .eval<boolean>(
        `document.readyState === 'complete' && !!document.getElementById('shadow-host')?.shadowRoot`,
      )
      .catch(() => false);
    if (ready) break;
    await sleep(250);
  }

  // ── Case A: duplicate-id button (the button#container ×N page) ────────────
  log('\n--- Case A: duplicate-id button in the top document ---');
  const a = await pickWithClick(
    browserWsUrl,
    hand,
    center(`document.querySelectorAll('#legend button')[1]`),
  );
  assert('picked' in a, 'A: expected a picked result');
  const ap = (a as Extract<PickResult, { picked: unknown }>).picked;
  log('A picked:', JSON.stringify({ tag: ap.tag, role: ap.role, name: ap.accessibleName, uniquePath: ap.uniquePath }));
  assert(ap.tag === 'button' && ap.id === 'container', `A: wrong element: ${ap.tag}#${ap.id}`);
  assert(ap.role === 'button', `A: computed role should be 'button', got '${ap.role}'`);
  assert(ap.accessibleName === 'Add comparison', `A: accessibleName should be 'Add comparison', got '${ap.accessibleName}'`);
  const idCand = ap.candidates.find((c) => c.css === 'button#container');
  assert(idCand && idCand.matchCount === 3, `A: button#container must report matchCount 3, got ${JSON.stringify(ap.candidates)}`);
  const ariaCand = ap.candidates.find((c) => c.css.includes('aria-label'));
  assert(ariaCand && ariaCand.matchCount === 1, `A: aria-label candidate must be unique, got ${JSON.stringify(ap.candidates)}`);
  assert(ap.marker, 'A: marker must be injected');
  assert(ap.uniquePath, 'A: uniquePath must exist');
  const aCheck = await hand.eval<{ markers: number; pathCount: number; pathHasMarker: boolean }>(
    `(() => {
       const markers = document.querySelectorAll('[data-qa-pick]').length;
       const hits = document.querySelectorAll(${JSON.stringify(ap.uniquePath)});
       return { markers, pathCount: hits.length, pathHasMarker: hits.length === 1 && hits[0].getAttribute('data-qa-pick') === ${JSON.stringify(ap.marker!.value)} };
     })()`,
  );
  assert(aCheck.markers === 1, `A: exactly one marker in the document, got ${aCheck.markers}`);
  assert(aCheck.pathCount === 1, `A: uniquePath must match exactly 1 node, got ${aCheck.pathCount}`);
  assert(aCheck.pathHasMarker, 'A: uniquePath must resolve to the marked element');
  assert(ap.isInteractive === true, 'A: button must be isInteractive');
  assert(ap.inFrame === false && ap.frameChain.length === 0, 'A: top-document element must have empty frameChain');
  assert(ap.shadow === 'none' && ap.scope === 'document', 'A: no shadow involvement expected');
  assert(ap.rect && ap.rect.width > 0 && ap.rect.height > 0, 'A: rect must be present');
  log('OK  A: live matchCounts (3/1), verified uniquePath, marker on the clicked node');

  // ── Case B: button inside an OPEN shadow root ──────────────────────────────
  log('\n--- Case B: open shadow DOM ---');
  const b = await pickWithClick(
    browserWsUrl,
    hand,
    center(`document.getElementById('shadow-host').shadowRoot.querySelector('button')`),
  );
  assert('picked' in b, 'B: expected a picked result');
  const bp = (b as Extract<PickResult, { picked: unknown }>).picked;
  log('B picked:', JSON.stringify({ tag: bp.tag, name: bp.accessibleName, scope: bp.scope, shadow: bp.shadow }));
  assert(bp.accessibleName === 'Shadow button', `B: accessibleName, got '${bp.accessibleName}'`);
  assert(bp.scope === 'shadowRoot', `B: scope must be shadowRoot, got '${bp.scope}'`);
  assert(bp.shadow === 'open', `B: shadow must be 'open', got '${bp.shadow}'`);
  const bHost = bp.ancestors.find((x) => x.shadowRoot);
  assert(bHost && bHost.shadowRoot === 'open' && bHost.id === 'shadow-host', `B: host ancestor must be flagged shadowRoot:'open', got ${JSON.stringify(bp.ancestors)}`);
  const bCheck = await hand.eval<boolean>(
    `document.getElementById('shadow-host').shadowRoot.querySelector('button').getAttribute('data-qa-pick') === ${JSON.stringify(bp.marker?.value ?? '')}`,
  );
  assert(bCheck, 'B: marker must be set on the shadow button');
  log('OK  B: shadow scope + host flag + marker inside the shadow root');

  // ── Case C: button inside a SAME-ORIGIN iframe ─────────────────────────────
  log('\n--- Case C: same-origin iframe ---');
  const c = await pickWithClick(browserWsUrl, hand, center(`document.getElementById('child-frame')`));
  assert('picked' in c, 'C: expected a picked result');
  const cp = (c as Extract<PickResult, { picked: unknown }>).picked;
  log('C picked:', JSON.stringify({ name: cp.accessibleName, frameChain: cp.frameChain, complete: cp.frameChainComplete }));
  assert(cp.accessibleName === 'Frame button', `C: accessibleName, got '${cp.accessibleName}'`);
  assert(cp.inFrame === true, 'C: inFrame must be true');
  assert(cp.frameChain.length === 1 && cp.frameChain[0].selector === 'iframe#child-frame', `C: frameChain must be [iframe#child-frame], got ${JSON.stringify(cp.frameChain)}`);
  assert(cp.frameChainComplete === true, 'C: frameChainComplete must be true');
  const cCheck = await hand.eval<boolean>(
    `document.getElementById('child-frame').contentDocument.querySelector('button').getAttribute('data-qa-pick') === ${JSON.stringify(cp.marker?.value ?? '')}`,
  );
  assert(cCheck, 'C: marker must be set on the iframe button');
  log('OK  C: same-origin frameChain + marker inside the frame');

  // ── Case D: button inside a CROSS-ORIGIN iframe (OOPIF) ────────────────────
  log('\n--- Case D: cross-origin OOPIF ---');
  const d = await pickWithClick(browserWsUrl, hand, center(`document.getElementById('xorigin-frame')`));
  assert('picked' in d, 'D: expected a picked result');
  const dp = (d as Extract<PickResult, { picked: unknown }>).picked;
  log('D picked:', JSON.stringify({ name: dp.accessibleName, frameChain: dp.frameChain, complete: dp.frameChainComplete, frameUrl: dp.frameUrl }));
  assert(dp.accessibleName === 'Cross button', `D: accessibleName, got '${dp.accessibleName}'`);
  assert(dp.inFrame === true, 'D: inFrame must be true');
  assert(dp.frameChain.length === 1 && dp.frameChain[0].selector === 'iframe#xorigin-frame', `D: frameChain must be [iframe#xorigin-frame], got ${JSON.stringify(dp.frameChain)}`);
  assert(dp.frameChainComplete === true, 'D: frameChainComplete must be true (OOPIF stitch)');
  assert(dp.marker, 'D: marker must be injected in the OOPIF document');
  log('OK  D: OOPIF stitched frameChain + AX facts across the process boundary');

  // ── Case E: canvas (chart surface) ─────────────────────────────────────────
  log('\n--- Case E: canvas ---');
  const e = await pickWithClick(browserWsUrl, hand, center(`document.getElementById('chart')`));
  assert('picked' in e, 'E: expected a picked result');
  const ep = (e as Extract<PickResult, { picked: unknown }>).picked;
  log('E picked:', JSON.stringify({ tag: ep.tag, rect: ep.rect, interactive: ep.isInteractive }));
  assert(ep.tag === 'canvas', `E: must pick the canvas, got ${ep.tag}`);
  assert(ep.rect && Math.abs(ep.rect.width - 200) <= 2 && Math.abs(ep.rect.height - 80) <= 2, `E: rect must report the canvas box, got ${JSON.stringify(ep.rect)}`);
  assert(ep.isInteractive === false, 'E: canvas is not interactive');
  log('OK  E: rect is the coordinate handle for chart surfaces');

  hand.close();
  log('\nE2E PASSED ✅  (live matchCounts, verified uniquePath, marker handoff, OOPIF frameChain, canvas rect)');
  await teardown();
  process.exit(0);
} catch (err) {
  await teardown();
  fail((err as Error).message);
}
