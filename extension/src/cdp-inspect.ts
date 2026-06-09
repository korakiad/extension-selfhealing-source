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

/** One `<iframe>` hop on the path from the top document to the picked node. */
export interface FrameRef {
  /**
   * Plain CSS selector for the `<iframe>` element itself, preference-ordered
   * (data-e2e/test/testid → id → name → first class → tag). Framework-neutral —
   * enter the frame using whatever frame-entry idiom the consumer project's own
   * tests use (discovered from its codebase, not assumed here).
   */
  selector: string;
  /** Content URL loaded in that frame — identifies it for a human; not a selector. */
  url: string;
}

/** A compact descriptor for one DOM ancestor of the picked node (for scoping a locator). */
export interface AncestorRef {
  tag: string;
  id: string;
  /** Up to the first 8 class names. */
  classes: string[];
  /** `data-*` attributes, de-prefixed. */
  data: Record<string, string>;
  /** `role` attribute, if any. */
  role: string;
  /** `aria-label`, if any. */
  ariaLabel: string;
  /** `name` attribute, if any. */
  name: string;
  /** Preference-ordered CSS selector for this ancestor (same rules as a FrameRef selector). */
  selector: string;
  /** 1-based position among same-tag siblings (0 if unknown). Use to build a `:nth-of-type(n)` qualifier. */
  nthOfType: number;
  /** Present + true when reaching this ancestor crossed a shadow-DOM boundary (it is the shadow host). */
  shadowHost?: boolean;
}

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
  /**
   * Preference-ordered **plain CSS** selector for the picked node itself
   * (data-e2e/test/testid → id → name → first class → tag, with a
   * `:nth-of-type(n)` fallback when nothing stable exists). Framework-neutral
   * (usable wherever a CSS selector is accepted). NOT authoritative — build the
   * real locator from the structured attributes (data/aria/role/text) in the
   * consumer project's own pattern, discovered from its codebase.
   */
  selector: string;
  /** 1-based position among same-tag siblings (0 if unknown). Fallback disambiguator when no stable hook exists. */
  nthOfType: number;
  /** True when the picked node lives inside an iframe (any origin). */
  inFrame: boolean;
  /** The owning (innermost) frame's own URL. See `frameChain` for the full ancestry. */
  frameUrl: string;
  /**
   * Ordered **outer→inner** iframe ancestry from the top document down to the
   * picked node's frame. Empty when the node is in the top document. Each
   * `selector` is plain CSS for an iframe element; enter the frames in order
   * using the consumer project's own frame-entry idiom (discovered from its
   * codebase). Handles arbitrarily nested frames AND cross-origin OOPIFs.
   */
  frameChain: FrameRef[];
  /**
   * DOM ancestors of the picked node WITHIN its own frame, ordered **nearest→outermost**
   * (immediate parent first, up to `<html>` or ~15 levels), crossing open shadow-DOM
   * boundaries. Use these to scope/disambiguate a locator when the leaf alone is not
   * unique in a complex app (e.g. `…locator('[data-e2e="panel"]').getByRole('button')`).
   */
  ancestors: AncestorRef[];
  /**
   * False when an intermediate frame boundary could not be resolved (rare:
   * a same-process cross-origin frame). When false, `frameChain` may be missing
   * levels — fall back to manual frame identification for those.
   */
  frameChainComplete: boolean;
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

// In-page helper (source text, spliced into the functions below): build a CSS
// selector for an element, preference-ordered, suitable for Playwright's
// frameLocator()/locator(). Skips attribute values containing quotes/backslashes
// (falls back to a less specific selector) so the emitted CSS is always valid.
const SEL_FOR_SRC = `
  function nthOfTypeOf(el) {
    try {
      var p = el.parentNode; if (!p || !p.children) return 0;
      var tag = el.tagName, k = 0, sibs = p.children;
      for (var i = 0; i < sibs.length; i++) { if (sibs[i].tagName === tag) { k++; if (sibs[i] === el) return k; } }
    } catch (e) {}
    return 0;
  }
  function selFor(el) {
    function esc(s) { try { return (window.CSS && CSS.escape) ? CSS.escape('' + s) : ('' + s); } catch (e) { return '' + s; } }
    function safe(v) { if (v == null) return null; v = '' + v; return (v.indexOf('"') >= 0 || v.indexOf('\\\\') >= 0) ? null : v; }
    var tag = (el.tagName || '').toLowerCase();
    var g = el.getAttribute ? function (n) { return el.getAttribute(n); } : function () { return null; };
    var names = ['data-e2e', 'data-test', 'data-testid', 'data-test-id'];
    for (var i = 0; i < names.length; i++) { var dv = safe(g(names[i])); if (dv) return tag + '[' + names[i] + '="' + dv + '"]'; }
    if (el.id) { var idv = safe(el.id); if (idv) return tag + '#' + esc(el.id); }
    var nm = safe(g('name')); if (nm) return tag + '[name="' + nm + '"]';
    if (el.classList && el.classList.length) { var cv = safe(el.classList[0]); if (cv) return tag + '.' + esc(el.classList[0]); }
    // No stable hook: fall back to a locally-unique :nth-of-type position.
    var n = nthOfTypeOf(el);
    return n > 0 ? tag + ':nth-of-type(' + n + ')' : tag;
  }
`;

// In-page helper (source text): from a starting window, climb the frame ancestry
// as far as same-origin access allows, collecting each owning <iframe>'s selector
// (inner→outer). Stops at the top (reachedTop=true) or at the first cross-origin
// boundary — where window.frameElement is null — which is a process/session edge
// that the CDP stitch loop crosses via DOM.getFrameOwner.
const CLIMB_SRC = `
  function climb(startWin) {
    var chain = [], reachedTop = false, win = startWin;
    try {
      for (var guard = 0; guard < 50; guard++) {
        var atTop = false; try { atTop = (win === win.top); } catch (e) { atTop = false; }
        if (atTop) { reachedTop = true; break; }
        var fe = null; try { fe = win.frameElement; } catch (e) { fe = null; }
        if (!fe) break;
        var url = ''; try { url = '' + win.location.href; } catch (e) {}
        chain.push({ selector: selFor(fe), url: url });
        var nxt = null; try { nxt = win.parent; } catch (e) { nxt = null; }
        if (!nxt || nxt === win) break;
        win = nxt;
      }
    } catch (e) {}
    return { chain: chain, reachedTop: reachedTop };
  }
`;

// In-page helper (source text): walk the picked node's DOM ancestors within its
// own frame (nearest→outermost, capped), crossing open shadow-DOM boundaries via
// getRootNode().host. Returns a compact descriptor per ancestor so the model can
// scope a locator when the leaf alone is not unique.
const ANCESTORS_SRC = `
  function descOf(el) {
    var data = {};
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) { var a = attrs[i]; if (a.name.indexOf('data-') === 0) data[a.name.slice(5)] = a.value; }
    var classes = []; try { classes = [].slice.call(el.classList || []).slice(0, 8); } catch (e) {}
    var g = el.getAttribute ? function (n) { return el.getAttribute(n); } : function () { return null; };
    return {
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || '',
      classes: classes,
      data: data,
      role: g('role') || '',
      ariaLabel: g('aria-label') || '',
      name: g('name') || '',
      selector: selFor(el),
      nthOfType: nthOfTypeOf(el),
    };
  }
  function ancestorsOf(start) {
    var out = [], node = start, guard = 0;
    while (node && guard < 15) {
      guard++;
      var parent = node.parentElement;
      if (!parent) {
        var root = null; try { root = node.getRootNode(); } catch (e) {}
        if (root && root.host) { var d = descOf(root.host); d.shadowHost = true; out.push(d); node = root.host; continue; }
        break;
      }
      out.push(descOf(parent));
      if ((parent.tagName || '').toLowerCase() === 'html') break;
      node = parent;
    }
    return out;
  }
`;

// Extracts the picked node's attributes AND its same-origin frame ancestry. Runs
// (via Runtime.callFunctionOn on the SESSION that owns the node) in the node's
// OWN frame context, so shadow/iframe are already resolved and window.top/location
// report the owning frame. `this` is the resolved DOM node. Returns a JSON string.
// `frameChain` here is only the same-origin ancestry within this session; the
// caller stitches across OOPIF boundaries when `reachedTop` is false.
const EXTRACT_AND_WALK_FN = `function () {
  ${SEL_FOR_SRC}
  ${CLIMB_SRC}
  ${ANCESTORS_SRC}
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
  var w = climb((el.ownerDocument && el.ownerDocument.defaultView) || window);
  return JSON.stringify({
    tag: (el.tagName || '').toLowerCase(),
    id: el.id || '',
    name: el.getAttribute ? (el.getAttribute('name') || '') : '',
    classes: classes,
    data: data,
    aria: aria,
    text: (el.textContent || '').trim().substring(0, 200),
    selector: selFor(el),
    nthOfType: nthOfTypeOf(el),
    inFrame: inFrame,
    frameUrl: frameUrl,
    frameChain: w.chain,
    reachedTop: w.reachedTop,
    ancestors: ancestorsOf(el),
  });
}`;

// Resolves an owning <iframe> element (found via DOM.getFrameOwner on the parent
// session) to its own selector PLUS its same-origin frame ancestry. `this` is the
// <iframe> element. Used by the OOPIF stitch loop, one hop per process boundary.
const FRAME_OWNER_WALK_FN = `function () {
  ${SEL_FOR_SRC}
  ${CLIMB_SRC}
  var el = this;
  var w = climb((el.ownerDocument && el.ownerDocument.defaultView) || window);
  return JSON.stringify({ selfSelector: selFor(el), chain: w.chain, reachedTop: w.reachedTop });
}`;

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
  // OOPIF session tree, for stitching the frame ancestry across process edges:
  //  - child session id → its parent session id (`undefined` = root page session)
  //  - session id (`undefined` = root) → its own root frame's id + content URL
  const sessionParent = new Map<string, string | undefined>();
  const sessionFrame = new Map<string | undefined, { id: string; url: string }>();
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
      await send('Page.enable', {}, sessionId).catch(() => {});
      // Record this session's own root frame (id + url) so the frame-ancestry
      // stitch can map a session → the <iframe> that owns it in its parent.
      try {
        const ft = await send('Page.getFrameTree', {}, sessionId);
        const f = ft?.frameTree?.frame;
        if (f?.id) sessionFrame.set(sessionId, { id: f.id, url: f.url ?? '' });
      } catch {
        /* frame ancestry degrades to frameChainComplete:false for this session */
      }
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
      // The flat-protocol envelope `sessionId` is the PARENT session that
      // auto-attached this child (absent ⇒ the root page session).
      if (typeof msg.params.sessionId === 'string') {
        sessionParent.set(msg.params.sessionId, typeof msg.sessionId === 'string' ? msg.sessionId : undefined);
      }
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

    // Resolve on the SAME session that reported the click (per-process backendNodeId),
    // extracting the node's attributes + its same-origin frame ancestry in one call.
    const { object } = await send('DOM.resolveNode', { backendNodeId: ended.backendNodeId }, ended.sessionId);
    const r = await send(
      'Runtime.callFunctionOn',
      { objectId: object.objectId, functionDeclaration: EXTRACT_AND_WALK_FN, returnByValue: true },
      ended.sessionId,
    );

    const raw = r?.result?.value;
    if (typeof raw !== 'string') {
      close();
      throw new QaToolError('CDP_CONNECT_FAILED', 'Could not read the picked node attributes.');
    }
    const leaf = JSON.parse(raw) as Omit<PickedElement, 'frameChainComplete'> & {
      reachedTop: boolean;
    };

    // Build the full outer→inner iframe ancestry. `leaf.frameChain` already holds
    // the same-origin ancestors within the picked node's own session (inner→outer);
    // when it did not reach the top, climb across OOPIF process boundaries: for each
    // session, DOM.getFrameOwner on its PARENT session yields the <iframe> that hosts
    // it, then walk that iframe's own same-origin ancestors, repeating to the root.
    const frameChain: FrameRef[] = Array.isArray(leaf.frameChain) ? [...leaf.frameChain] : [];
    let complete = true;
    if (!leaf.reachedTop) {
      let session = ended.sessionId;
      const visited = new Set<string | undefined>();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (session === undefined || visited.has(session)) {
          complete = false; // root reached without hitting top ⇒ same-process cross-origin gap
          break;
        }
        visited.add(session);
        const frame = sessionFrame.get(session);
        if (!frame?.id) {
          complete = false;
          break;
        }
        const parent = sessionParent.get(session);
        try {
          const owner = await send('DOM.getFrameOwner', { frameId: frame.id }, parent);
          if (owner?.backendNodeId == null) {
            complete = false;
            break;
          }
          const { object: ownerObj } = await send(
            'DOM.resolveNode',
            { backendNodeId: owner.backendNodeId },
            parent,
          );
          const wr = await send(
            'Runtime.callFunctionOn',
            { objectId: ownerObj.objectId, functionDeclaration: FRAME_OWNER_WALK_FN, returnByValue: true },
            parent,
          );
          const w = JSON.parse(wr.result.value) as {
            selfSelector: string;
            chain: FrameRef[];
            reachedTop: boolean;
          };
          frameChain.push({ selector: w.selfSelector, url: frame.url || '' });
          if (Array.isArray(w.chain)) frameChain.push(...w.chain);
          if (w.reachedTop) break;
          session = parent;
        } catch {
          complete = false;
          break;
        }
      }
    }
    close();

    frameChain.reverse(); // inner→outer accumulation → outer→inner result
    const { reachedTop: _reachedTop, frameChain: _leafChain, ...rest } = leaf;
    const picked: PickedElement = {
      ...rest,
      frameChain,
      frameChainComplete: complete,
    };
    return { picked };
  } catch (err) {
    close();
    if (err instanceof QaToolError) throw err;
    throw new QaToolError('CDP_CONNECT_FAILED', `CDP inspect failed: ${(err as Error).message}`);
  }
}
