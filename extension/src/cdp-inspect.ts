/**
 * Drives Chrome's native DevTools "inspect element" overlay (CDP `Overlay`
 * domain) over a raw WebSocket to the held browser — with NO page-script
 * injection.
 *
 * Why native, not a `browser_evaluate` page-script picker: the hit-test runs in
 * the browser process, so it pierces every boundary a page script cannot —
 * cross-origin iframes, open AND closed shadow DOM, web components, and canvas
 * overlays. `document.elementFromPoint` (the page-script approach) stops at a
 * shadow host / iframe shell and can't read a cross-origin frame at all; the
 * Overlay inspector resolves straight to the real leaf node. The QA just hovers
 * (Chrome highlights the element) and clicks once, anywhere, unaware of frames
 * or shadow roots.
 *
 * Cross-origin frames (OOPIFs): a cross-origin iframe is an out-of-process
 * iframe — a SEPARATE CDP target with its own session, and `backendNodeId` is
 * per-process. So we `Target.setAutoAttach({flatten:true})` from the page
 * session (recursively), arm inspect mode on EVERY attached frame session, and
 * resolve the picked node on the SAME session that emitted
 * `Overlay.inspectNodeRequested`. Same-origin iframes are in-process (one
 * session) and handled by the root session alone. (Without auto-attach a single
 * session cannot resolve nodes inside a cross-origin OOPIF — Chromium
 * site-isolation; backendNodeIds are per-process.)
 *
 * Used by the `qa_pick_element` LM tool. Host-agnostic (no `vscode` import).
 */

import { WebSocket, type RawData } from 'ws';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

export interface PickedElement {
  tag: string;
  id: string;
  name: string;
  classes: string[];
  /** `data-*` attributes, de-prefixed (e.g. `data-e2e` → `{ e2e: '...' }`). */
  data: Record<string, string>;
  /** `aria-*` attributes de-prefixed, plus `role`. */
  aria: Record<string, string>;
  text: string;
  /** True when the picked node lives inside an iframe (any origin). */
  inFrame: boolean;
  /** The owning frame's own URL — anchors a frameLocator when `inFrame`. */
  frameUrl: string;
  /** Preference-ordered hint (data-e2e/test → id → role → class → tag); NOT authoritative. */
  suggestedLocator: string;
}

export type PickResult =
  | { picked: PickedElement }
  | { cancelled: true; reason: 'timeout' | 'cancelled' };

const DEFAULT_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 2_000;

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 255, g: 51, b: 51, a: 0.2 },
  paddingColor: { r: 255, g: 153, b: 0, a: 0.1 },
  borderColor: { r: 255, g: 51, b: 51, a: 0.6 },
};

/** `ws://host/devtools/...` → `http://host`. */
function wsUrlToHttpRoot(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `http://${u.host}`;
}

/**
 * Resolve a page-level CDP target from a chrome's http root and return its
 * page WebSocket debugger URL. Prefers a real (non-blank, non-chrome://) page.
 */
export async function resolvePageWsUrl(httpRoot: string): Promise<string> {
  let targets: Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
  try {
    const res = await fetch(`${httpRoot}/json/list`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`/json/list returned ${res.status}`);
    targets = (await res.json()) as typeof targets;
  } catch (err) {
    throw new QaToolError(
      'CDP_CONNECT_FAILED',
      `Could not reach the held browser CDP endpoint at ${httpRoot}: ${(err as Error).message}`,
    );
  }
  const pages = targets.filter(
    (t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string',
  );
  if (pages.length === 0) {
    throw new QaToolError('CDP_CONNECT_FAILED', `No inspectable page target at ${httpRoot}.`);
  }
  const real = pages.find(
    (p) => p.url && p.url !== 'about:blank' && !p.url.startsWith('chrome://'),
  );
  return (real ?? pages[0]).webSocketDebuggerUrl!;
}

// Extracts the picked node's attributes. Runs (via Runtime.callFunctionOn on the
// SESSION that owns the node) in the node's OWN frame context, so shadow/iframe
// are already resolved and window.top/location report the owning frame.
// `this` is the resolved DOM node. Returns a JSON string.
const EXTRACT_FN = `function () {
  var el = this;
  var data = {}, aria = {};
  var attrs = el.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    var a = attrs[i];
    if (a.name.indexOf('data-') === 0) data[a.name.slice(5)] = a.value;
    else if (a.name.indexOf('aria-') === 0) aria[a.name.slice(5)] = a.value;
  }
  var role = el.getAttribute ? (el.getAttribute('role') || '') : '';
  var classes = [];
  try { classes = [].slice.call(el.classList || []); } catch (e) {}
  var inFrame = false, frameUrl = '';
  try { inFrame = window.top !== window.self; } catch (e) { inFrame = true; }
  try { frameUrl = location.href || ''; } catch (e) {}
  aria.role = role;
  return JSON.stringify({
    tag: (el.tagName || '').toLowerCase(),
    id: el.id || '',
    name: el.getAttribute ? (el.getAttribute('name') || '') : '',
    classes: classes,
    data: data,
    aria: aria,
    text: (el.textContent || '').trim().substring(0, 200),
    inFrame: inFrame,
    frameUrl: frameUrl,
  });
}`;

/** Preference order: data-e2e/test/testid → id → role → first class → tag. */
function buildLocatorHint(el: Omit<PickedElement, 'suggestedLocator'>): string {
  const d = el.data;
  let base: string;
  if (d.e2e) base = `locator('[data-e2e="${d.e2e}"]')`;
  else if (d.test) base = `locator('[data-test="${d.test}"]')`;
  else if (d.testid) base = `locator('[data-testid="${d.testid}"]')`;
  else if (d['test-id']) base = `locator('[data-test-id="${d['test-id']}"]')`;
  else if (el.id) base = `locator('#${el.id}')`;
  else if (el.aria.role) base = `getByRole('${el.aria.role}')`;
  else if (el.classes.length) base = `locator('.${el.classes[0]}')`;
  else base = `locator('${el.tag}')`;
  return el.inFrame ? `frameLocator(/* iframe at ${el.frameUrl} */).${base}` : base;
}

interface PickOptions {
  /** Defaults to 120s. */
  timeoutMs?: number;
  /** Aborts the pick (e.g. from a VS Code CancellationToken). */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/**
 * Arm Chrome's element inspector on the selected held browser and resolve with
 * the element the QA clicks (or `cancelled` on timeout / abort). Arms across the
 * root page session AND every attached frame target (cross-origin OOPIFs), and
 * resolves on whichever session reported the click.
 *
 * @param selectedChromeWsUrl the selected chrome's browser-level CDP ws URL
 *        (AvailableChrome.ws_url). The page target is resolved from its http root.
 */
export async function pickElementViaOverlay(
  selectedChromeWsUrl: string,
  opts: PickOptions = {},
): Promise<PickResult> {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageWsUrl = await resolvePageWsUrl(wsUrlToHttpRoot(selectedChromeWsUrl));

  const ws = new WebSocket(pageWsUrl, { perMessageDeflate: false });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // Frame sessions we've armed inspect mode on. `undefined` = the root page
  // session; strings = attached child-target (OOPIF) sessions.
  const armed = new Set<string | undefined>();
  let onInspect: ((p: { sessionId?: string; backendNodeId: number }) => void) | null = null;

  // Flat CDP protocol: child-session commands/events carry a `sessionId`.
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });

  // Enable the domains + arm inspect mode + recurse auto-attach on one session.
  const armSession = async (
    sessionId: string | undefined,
    info: { type: string; url?: string },
  ): Promise<void> => {
    if (info.type !== 'page' && info.type !== 'iframe') return; // skip workers / service workers
    if (armed.has(sessionId)) return;
    armed.add(sessionId);
    try {
      await send('DOM.enable', {}, sessionId);
      await send('Runtime.enable', {}, sessionId);
      await send('Overlay.enable', {}, sessionId);
      // Recurse so nested cross-origin frames attach too.
      await send(
        'Target.setAutoAttach',
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
        sessionId,
      );
      await send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT_CONFIG }, sessionId);
      log(`[cdp-inspect] armed ${sessionId ?? 'root'} ${info.type} ${info.url ?? ''}`.trim());
    } catch (e) {
      log(`[cdp-inspect] arm session ${sessionId ?? 'root'} (${info.type}) failed: ${(e as Error).message}`);
    }
  };

  ws.on('message', (raw: RawData) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method === 'Overlay.inspectNodeRequested' && onInspect) {
      onInspect({ sessionId: msg.sessionId, backendNodeId: msg.params.backendNodeId });
    } else if (msg.method === 'Target.attachedToTarget') {
      // Child frame sessions attach asynchronously, after the root is armed. A
      // click in an OOPIF not yet armed simply emits no inspectNodeRequested
      // (the QA clicks again once it's armed) — it never misfires on the wrong node.
      const ti = msg.params.targetInfo ?? {};
      void armSession(msg.params.sessionId, { type: ti.type ?? '', url: ti.url });
    }
  });

  const close = (): void => {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      /* ignore */
    }
    // Fail any in-flight commands so nothing hangs past teardown.
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed'));
    pending.clear();
  };
  // A dropped socket mid-pick must not hang until the timeout.
  ws.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed'));
    pending.clear();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e: Error) => reject(e));
    });
  } catch (err) {
    close();
    throw new QaToolError(
      'CDP_CONNECT_FAILED',
      `Could not open CDP page session: ${(err as Error).message}`,
    );
  }

  try {
    const clicked = new Promise<{ sessionId?: string; backendNodeId: number }>((resolve) => {
      onInspect = resolve;
    });

    // Root page session (handles top frame + same-origin in-process subframes),
    // then auto-attach pulls in cross-origin OOPIF sessions, each armed via the
    // Target.attachedToTarget handler above.
    await armSession(undefined, { type: 'page' });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const ended = await Promise.race<{ sessionId?: string; backendNodeId: number } | 'timeout' | 'cancelled'>([
      clicked,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
      new Promise<'cancelled'>((resolve) => {
        if (opts.signal) {
          if (opts.signal.aborted) resolve('cancelled');
          else {
            onAbort = () => resolve('cancelled');
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);

    // Turn the inspector back off on every session we armed.
    for (const sessionId of armed) {
      await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId).catch(() => {});
    }

    if (ended === 'timeout' || ended === 'cancelled') {
      close();
      return { cancelled: true, reason: ended };
    }

    // Resolve on the SAME session that reported the click (per-process backendNodeId).
    const { object } = await send('DOM.resolveNode', { backendNodeId: ended.backendNodeId }, ended.sessionId);
    const r = await send(
      'Runtime.callFunctionOn',
      { objectId: object.objectId, functionDeclaration: EXTRACT_FN, returnByValue: true },
      ended.sessionId,
    );
    close();

    const raw = r?.result?.value;
    if (typeof raw !== 'string') {
      throw new QaToolError('CDP_CONNECT_FAILED', 'Could not read the picked node attributes.');
    }
    const el = JSON.parse(raw) as Omit<PickedElement, 'suggestedLocator'>;
    return { picked: { ...el, suggestedLocator: buildLocatorHint(el) } };
  } catch (err) {
    close();
    if (err instanceof QaToolError) throw err;
    throw new QaToolError('CDP_CONNECT_FAILED', `CDP inspect failed: ${(err as Error).message}`);
  }
}
