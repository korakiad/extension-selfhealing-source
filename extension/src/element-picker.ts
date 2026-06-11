/**
 * Element picker — arms Chrome's native DevTools "inspect element" overlay
 * (CDP `Overlay` domain) over a raw WebSocket, then extracts a
 * VERIFICATION-READY description of the node the QA clicks.
 *
 * Why native, not a page-script picker: the hit-test runs in the browser
 * process, so it pierces every boundary a page script cannot — cross-origin
 * iframes (OOPIFs), open AND closed shadow DOM, web components, and canvas
 * overlays. The QA just hovers (Chrome highlights) and clicks once, unaware of
 * frames or shadow roots.
 *
 * Why "verification-ready" (the rewrite): a guessed CSS selector is worthless
 * on a real app — complex pages reuse ids and classes freely (e.g. one
 * `button#container` per widget, dozens per page), so a selector built from
 * the clicked node's own attributes is silently ambiguous. This engine never
 * hands over an unverified guess. Every pick returns three independent handles
 * the model can CHECK against the live page through the attached browser
 * tools (playwright-mcp):
 *
 *  1. `role` + `accessibleName` — the COMPUTED accessibility role and name
 *     (CDP `Accessibility.getPartialAXTree`), i.e. the exact vocabulary of
 *     `browser_snapshot`. The model finds the picked node in a snapshot by
 *     these, then drives/asserts through the snapshot ref.
 *  2. `marker` — a `data-qa-pick="<nonce>"` attribute injected onto the picked
 *     element. Guaranteed unique (fresh nonce per pick; prior markers in the
 *     same root are cleared), so any snapshot ref or candidate locator can be
 *     verified with one `browser_evaluate` marker check — no matter how
 *     hostile the page's own attributes are. Volatile by design: gone on
 *     reload/re-render; never the final locator.
 *  3. `candidates` + `uniquePath` — plain-CSS selectors with matchCount
 *     COUNTED LIVE in the leaf's root (document or shadow root). matchCount 1
 *     means actually unique there; `uniquePath` is a child-combinator path
 *     extended ancestor-by-ancestor until it verifiably matches exactly one
 *     node.
 *
 * Cross-origin frames (OOPIFs): a cross-origin iframe is a SEPARATE CDP target
 * with its own session, and `backendNodeId` is per-process. So we
 * `Target.setAutoAttach({flatten:true})` recursively, arm inspect mode on
 * EVERY attached frame session, and resolve the picked node on the SAME
 * session that emitted `Overlay.inspectNodeRequested`, stitching the iframe
 * ancestry across process edges via `DOM.getFrameOwner` on the parent session.
 *
 * Used by the `qa_pick_element` LM tool. Host-agnostic (no `vscode` import).
 */

import { randomUUID } from 'node:crypto';

import { WebSocket, type RawData } from 'ws';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

/** The attribute injected on the picked element as a verification handle. */
export const PICK_MARKER_ATTR = 'data-qa-pick';

/** One `<iframe>` hop on the path from the top document to the picked node. */
export interface FrameRef {
  /**
   * Plain CSS for the `<iframe>` element in its own document — the strongest
   * hook that is unique among its siblings (test-attr → id → name → aria-label
   * → title → role → class → tag, with `:nth-of-type(n)` appended when nothing
   * discriminates). Framework-neutral: enter the frame with whatever idiom the
   * consumer project's own tests use.
   */
  selector: string;
  /** Content URL loaded in that frame — identifies it to a human; not a selector. */
  url: string;
}

/** A leaf CSS selector candidate with its LIVE match count. */
export interface SelectorCandidate {
  /** Plain CSS for the picked element itself (single compound selector, no combinators). */
  css: string;
  /**
   * How many nodes this selector matches in the leaf's root (document or
   * shadow root) at pick time. 1 = unique there. -1 = could not be counted.
   */
  matchCount: number;
}

/** A compact descriptor for one DOM ancestor of the picked node. */
export interface AncestorRef {
  tag: string;
  id: string;
  /** Up to the first 8 class names. */
  classes: string[];
  /** `data-*` attributes, de-prefixed. */
  data: Record<string, string>;
  /** `role` ATTRIBUTE, if any (computed role is only on the leaf). */
  role: string;
  ariaLabel: string;
  /** `name` attribute, if any. */
  name: string;
  /** Strongest sibling-unique CSS segment for this ancestor (same rules as FrameRef.selector). */
  selector: string;
  /** Live match count of `selector` alone within this ancestor's root. -1 = uncountable. */
  matchCount: number;
  /** 1-based position among same-tag siblings (0 if unknown). */
  nthOfType: number;
  /** Present + true when this ancestor looks actionable (button/link/input/role/tabindex/onclick). */
  interactive?: true;
  /**
   * Present when reaching this ancestor crossed a shadow boundary — it is the
   * shadow HOST, and the value is the shadow root's mode. A `'closed'` crossing
   * means no CSS selector can reach the leaf from outside this host.
   */
  shadowRoot?: 'open' | 'closed';
}

export interface PickedElement {
  tag: string;
  id: string;
  /** `name` attribute, if any. */
  name: string;
  classes: string[];
  /** `data-*` attributes, de-prefixed (e.g. `data-e2e` → `{ e2e: '...' }`). */
  data: Record<string, string>;
  /** `aria-*` attributes, de-prefixed. */
  aria: Record<string, string>;
  /** Trimmed textContent, first 200 chars. */
  text: string;
  /**
   * COMPUTED accessibility role (CDP Accessibility domain) — what
   * `browser_snapshot` displays, including implicit roles (`<button>` →
   * "button" with no role attribute). '' when the node has no AX presence.
   */
  role: string;
  /** COMPUTED accessible name (accname algorithm) — the snapshot's quoted name. '' when none. */
  accessibleName: string;
  /**
   * Verification handle injected onto the picked element:
   * `data-qa-pick="<nonce>"`. `selector` is the ready-made attribute selector.
   * Unique per pick (prior markers in the same root are cleared first; the
   * nonce is fresh). VOLATILE — cleared by the next pick, lost on reload or
   * re-render. Use it to verify a snapshot ref / candidate locator via
   * `browser_evaluate`; never ship it as the final locator. `null` when
   * injection failed (read-only DOM, CSP exotica).
   */
  marker: { attr: string; value: string; selector: string } | null;
  /**
   * Ranked leaf selector candidates, strongest hook first, EACH with a live
   * matchCount (see SelectorCandidate). The bare-tag candidate is included
   * last so the model can see how crowded the tag is.
   */
  candidates: SelectorCandidate[];
  /**
   * Child-combinator CSS path (`a > b > c`), extended ancestor-by-ancestor
   * until it matched EXACTLY ONE node in `scope` at pick time — a verified
   * unique plain-CSS answer even when every leaf candidate is ambiguous.
   * `null` only when no unique path could be built (hostile DOM).
   */
  uniquePath: string | null;
  /**
   * Where candidates/uniquePath were counted and where they resolve:
   * the leaf's own document, or its innermost shadow root. A `shadowRoot`
   * scope means plain `document.querySelector` will NOT find the leaf — see
   * `shadow` and the ancestors' `shadowRoot` flags.
   */
  scope: 'document' | 'shadowRoot';
  /** 1-based position among same-tag siblings (0 if unknown). Last-resort disambiguator. */
  nthOfType: number;
  /**
   * Border-box geometry in the OWNING frame's viewport coordinates (NOT the
   * top page's when inside an OOPIF). `null` when the node has no box (not
   * rendered). The coordinate handle for canvas/chart surfaces where no DOM
   * exists below the canvas element.
   */
  rect: { x: number; y: number; width: number; height: number } | null;
  /**
   * False when the QA clicked a presentational leaf (svg path, span, …). The
   * nearest `interactive: true` ancestor is then usually the intended target —
   * confirm with the QA before building a locator for either.
   */
  isInteractive: boolean;
  /**
   * Worst shadow boundary between the leaf and its document:
   * 'none' (no shadow), 'open' (CSS engines that pierce open roots can reach
   * it), 'closed' (NO selector can reach the leaf from outside — surface this
   * and follow the project's escape hatch).
   */
  shadow: 'none' | 'open' | 'closed';
  /** True when the picked node lives inside an iframe (any origin). */
  inFrame: boolean;
  /** The owning (innermost) frame's own URL. See `frameChain` for the full ancestry. */
  frameUrl: string;
  /**
   * Ordered **outer→inner** iframe ancestry from the top document down to the
   * picked node's frame. Empty when the node is in the top document. Handles
   * arbitrarily nested AND cross-origin (OOPIF) frames.
   */
  frameChain: FrameRef[];
  /**
   * False when an intermediate frame boundary could not be resolved (rare:
   * a same-process cross-origin frame) — `frameChain` may be missing levels.
   */
  frameChainComplete: boolean;
  /**
   * DOM ancestors WITHIN the leaf's own frame, nearest→outermost (immediate
   * parent first, up to `<html>` or ~15 levels), crossing shadow boundaries
   * (each crossing flagged via `shadowRoot`). Use to scope a locator when the
   * leaf alone is ambiguous, and to find the intended interactive target.
   */
  ancestors: AncestorRef[];
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

// ---------------------------------------------------------------------------
// In-page helper library (source text, ES5, spliced into the functions below).
// Everything is defensive: a hostile page must degrade a field, never throw.
// ---------------------------------------------------------------------------
const SHARED_SRC = `
  var TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-e2e', 'data-qa', 'data-cy', 'data-automation-id'];
  function esc(s) { try { return (window.CSS && CSS.escape) ? CSS.escape('' + s) : ('' + s); } catch (e) { return '' + s; } }
  function safeVal(v) { if (v == null) return null; v = '' + v; return (v === '' || v.indexOf('"') >= 0 || v.indexOf('\\\\') >= 0) ? null : v; }
  function attr(el, n) { try { return el.getAttribute ? el.getAttribute(n) : null; } catch (e) { return null; } }
  function rootOf(el) { try { var r = el.getRootNode ? el.getRootNode() : null; return (r && r.querySelectorAll) ? r : document; } catch (e) { return document; } }
  function countIn(root, sel) { try { return root.querySelectorAll(sel).length; } catch (e) { return -1; } }
  function nthOfTypeOf(el) {
    try {
      var p = el.parentNode; if (!p || !p.children) return 0;
      var tag = el.tagName, k = 0, sibs = p.children;
      for (var i = 0; i < sibs.length; i++) { if (sibs[i].tagName === tag) { k++; if (sibs[i] === el) return k; } }
    } catch (e) {}
    return 0;
  }
  // Ordered NON-positional selector candidates for one element, strongest hook first.
  function hookSegments(el) {
    var tag = (el.tagName || '').toLowerCase();
    var out = [];
    for (var i = 0; i < TEST_ATTRS.length; i++) {
      var tv = safeVal(attr(el, TEST_ATTRS[i]));
      if (tv) out.push(tag + '[' + TEST_ATTRS[i] + '="' + tv + '"]');
    }
    if (el.id && safeVal(el.id)) out.push(tag + '#' + esc(el.id));
    var nm = safeVal(attr(el, 'name')); if (nm) out.push(tag + '[name="' + nm + '"]');
    var al = safeVal(attr(el, 'aria-label')); if (al) out.push(tag + '[aria-label="' + al + '"]');
    var ti = safeVal(attr(el, 'title')); if (ti) out.push(tag + '[title="' + ti + '"]');
    var ro = safeVal(attr(el, 'role')); if (ro) out.push(tag + '[role="' + ro + '"]');
    try { if (el.classList && el.classList.length) { var cv = safeVal(el.classList[0]); if (cv) out.push(tag + '.' + esc(el.classList[0])); } } catch (e) {}
    out.push(tag);
    return out;
  }
  // Strongest segment matching ONLY el among its parent's element children;
  // appends :nth-of-type(n) when no hook discriminates between siblings.
  function segFor(el) {
    var segs = hookSegments(el);
    var p = el.parentNode;
    for (var i = 0; i < segs.length; i++) {
      if (!p || !p.children) return segs[i];
      var hits = 0;
      try {
        for (var j = 0; j < p.children.length; j++) { var c = p.children[j]; if (c.matches && c.matches(segs[i])) hits++; }
      } catch (e) { continue; }
      if (hits === 1) return segs[i];
    }
    var n = nthOfTypeOf(el);
    var tag = (el.tagName || '').toLowerCase();
    return n > 0 ? tag + ':nth-of-type(' + n + ')' : tag;
  }
  // Child-combinator path of sibling-unique segments, extended upward until the
  // whole path matches exactly one node in el's root. null when never unique.
  function uniquePathFor(el) {
    var root = rootOf(el);
    var segs = [], node = el;
    for (var guard = 0; node && guard < 40; guard++) {
      segs.unshift(segFor(node));
      var path = segs.join(' > ');
      if (countIn(root, path) === 1) return path;
      node = node.parentElement;
    }
    return null;
  }
  function candidatesFor(el, root) {
    var segs = hookSegments(el), out = [], seen = {};
    for (var i = 0; i < segs.length && out.length < 8; i++) {
      if (seen[segs[i]]) continue;
      seen[segs[i]] = 1;
      out.push({ css: segs[i], matchCount: countIn(root, segs[i]) });
    }
    return out;
  }
  var INTERACTIVE_TAGS = { a: 1, button: 1, input: 1, select: 1, textarea: 1, option: 1, summary: 1, label: 1 };
  var INTERACTIVE_ROLES = { button: 1, link: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, tab: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, option: 1, 'switch': 1, slider: 1, spinbutton: 1, searchbox: 1, textbox: 1, treeitem: 1 };
  function isInteractive(el) {
    try {
      var tag = (el.tagName || '').toLowerCase();
      if (INTERACTIVE_TAGS[tag]) return true;
      var r = attr(el, 'role'); if (r && INTERACTIVE_ROLES[r.toLowerCase()]) return true;
      var ti = attr(el, 'tabindex'); if (ti != null && +ti >= 0) return true;
      if (typeof el.onclick === 'function') return true;
      if (el.hasAttribute && el.hasAttribute('contenteditable')) return true;
    } catch (e) {}
    return false;
  }
  function descOf(el) {
    var data = {};
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) { var a = attrs[i]; if (a.name.indexOf('data-') === 0) data[a.name.slice(5)] = a.value; }
    var classes = []; try { classes = [].slice.call(el.classList || []).slice(0, 8); } catch (e) {}
    var seg = segFor(el);
    var d = {
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || '',
      classes: classes,
      data: data,
      role: attr(el, 'role') || '',
      ariaLabel: attr(el, 'aria-label') || '',
      name: attr(el, 'name') || '',
      selector: seg,
      matchCount: countIn(rootOf(el), seg),
      nthOfType: nthOfTypeOf(el),
    };
    if (isInteractive(el)) d.interactive = true;
    return d;
  }
  // Walk ancestors nearest→outermost, crossing shadow roots via getRootNode().host.
  // Tracks the WORST shadow boundary crossed ('closed' beats 'open').
  function ancestorsOf(start) {
    var out = [], node = start, guard = 0, shadow = 'none';
    while (node && guard < 15) {
      guard++;
      var parent = node.parentElement;
      if (!parent) {
        var root = null; try { root = node.getRootNode(); } catch (e) {}
        if (root && root.host) {
          var mode = 'closed'; try { if (root.mode === 'open') mode = 'open'; } catch (e) {}
          if (shadow !== 'closed') shadow = mode;
          var d = descOf(root.host); d.shadowRoot = mode;
          out.push(d);
          node = root.host;
          continue;
        }
        break;
      }
      out.push(descOf(parent));
      if ((parent.tagName || '').toLowerCase() === 'html') break;
      node = parent;
    }
    return { list: out, shadow: shadow };
  }
  // Inject the verification marker: clear stale markers in the same root, then
  // stamp the fresh nonce. Returns true iff the attribute reads back.
  function setMarker(el, nonce) {
    try {
      var root = rootOf(el);
      try {
        var prev = root.querySelectorAll('[${PICK_MARKER_ATTR}]');
        for (var i = 0; i < prev.length; i++) prev[i].removeAttribute('${PICK_MARKER_ATTR}');
      } catch (e) {}
      el.setAttribute('${PICK_MARKER_ATTR}', nonce);
      return attr(el, '${PICK_MARKER_ATTR}') === nonce;
    } catch (e) { return false; }
  }
`;

// In-page helper (source text): from a starting window, climb the frame
// ancestry as far as same-origin access allows, collecting each owning
// <iframe>'s selector (inner→outer). Stops at the top (reachedTop=true) or at
// the first cross-origin boundary — where window.frameElement is null — which
// is a process/session edge the CDP stitch loop crosses via DOM.getFrameOwner.
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
        chain.push({ selector: segFor(fe), url: url });
        var nxt = null; try { nxt = win.parent; } catch (e) { nxt = null; }
        if (!nxt || nxt === win) break;
        win = nxt;
      }
    } catch (e) {}
    return { chain: chain, reachedTop: reachedTop };
  }
`;

// Runs (via Runtime.callFunctionOn on the SESSION that owns the node) in the
// node's OWN frame context — shadow/iframe are already resolved; window/location
// report the owning frame. `this` is the resolved DOM node; the one argument is
// the fresh marker nonce. Returns a JSON string. `frameChain` here is only the
// same-origin ancestry within this session; the caller stitches across OOPIF
// boundaries when `reachedTop` is false.
const EXTRACT_FN = `function (nonce) {
  ${SHARED_SRC}
  ${CLIMB_SRC}
  var el = this;
  var root = rootOf(el);
  var data = {}, aria = {};
  var attrsList = el.attributes || [];
  for (var i = 0; i < attrsList.length; i++) {
    var a = attrsList[i];
    if (a.name.indexOf('data-') === 0) data[a.name.slice(5)] = a.value;
    else if (a.name.indexOf('aria-') === 0) aria[a.name.slice(5)] = a.value;
  }
  delete data['${PICK_MARKER_ATTR.slice(5)}'];
  var classes = [];
  try { classes = [].slice.call(el.classList || []).slice(0, 20); } catch (e) {}
  var inFrame = false, frameUrl = '';
  try { inFrame = window.top !== window.self; } catch (e) { inFrame = true; }
  try { frameUrl = location.href || ''; } catch (e) {}
  var markerOk = setMarker(el, nonce);
  var anc = ancestorsOf(el);
  var w = climb((el.ownerDocument && el.ownerDocument.defaultView) || window);
  return JSON.stringify({
    tag: (el.tagName || '').toLowerCase(),
    id: el.id || '',
    name: attr(el, 'name') || '',
    classes: classes,
    data: data,
    aria: aria,
    text: (el.textContent || '').trim().substring(0, 200),
    markerOk: markerOk,
    candidates: candidatesFor(el, root),
    uniquePath: uniquePathFor(el),
    scope: root.host ? 'shadowRoot' : 'document',
    nthOfType: nthOfTypeOf(el),
    isInteractive: isInteractive(el),
    shadow: anc.shadow,
    inFrame: inFrame,
    frameUrl: frameUrl,
    frameChain: w.chain,
    reachedTop: w.reachedTop,
    ancestors: anc.list,
  });
}`;

// Resolves an owning <iframe> element (found via DOM.getFrameOwner on the
// parent session) to its own selector PLUS its same-origin frame ancestry.
// `this` is the <iframe> element. One hop per OOPIF process boundary.
const FRAME_OWNER_FN = `function () {
  ${SHARED_SRC}
  ${CLIMB_SRC}
  var el = this;
  var w = climb((el.ownerDocument && el.ownerDocument.defaultView) || window);
  return JSON.stringify({ selfSelector: segFor(el), chain: w.chain, reachedTop: w.reachedTop });
}`;

/** Shape produced by EXTRACT_FN (in-page) before the node-side fields are merged. */
interface ExtractedLeaf {
  tag: string;
  id: string;
  name: string;
  classes: string[];
  data: Record<string, string>;
  aria: Record<string, string>;
  text: string;
  markerOk: boolean;
  candidates: SelectorCandidate[];
  uniquePath: string | null;
  scope: 'document' | 'shadowRoot';
  nthOfType: number;
  isInteractive: boolean;
  shadow: 'none' | 'open' | 'closed';
  inFrame: boolean;
  frameUrl: string;
  frameChain: FrameRef[];
  reachedTop: boolean;
  ancestors: AncestorRef[];
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
 * a verification-ready description of the element the QA clicks (or
 * `cancelled` on timeout / abort). Arms the root page session AND every
 * attached frame target (cross-origin OOPIFs), and resolves on whichever
 * session reported the click.
 *
 * @param selectedChromeWsUrl the selected chrome's browser-level CDP ws URL
 *        (AvailableChrome.ws_url). The page target is resolved from its http root.
 */
export async function pickElement(
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
      log(`[element-picker] armed ${sessionId ?? 'root'} ${info.type} ${info.url ?? ''}`.trim());
    } catch (e) {
      log(`[element-picker] arm session ${sessionId ?? 'root'} (${info.type}) failed: ${(e as Error).message}`);
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

    // --- Extraction, all on the SAME session that reported the click --------
    // (backendNodeId is per-process; a different session cannot resolve it).

    // 1) In-page facts + marker injection + verified selectors, in one call.
    const { object } = await send('DOM.resolveNode', { backendNodeId: ended.backendNodeId }, ended.sessionId);
    const nonce = randomUUID().slice(0, 13);
    const r = await send(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: EXTRACT_FN,
        arguments: [{ value: nonce }],
        returnByValue: true,
      },
      ended.sessionId,
    );
    const raw = r?.result?.value;
    if (typeof raw !== 'string') {
      close();
      throw new QaToolError('CDP_CONNECT_FAILED', 'Could not read the picked node attributes.');
    }
    const leaf = JSON.parse(raw) as ExtractedLeaf;

    // 2) Computed accessibility role + name — the browser_snapshot vocabulary.
    //    One-shot query; degrades to '' on runtimes without the domain.
    let role = '';
    let accessibleName = '';
    try {
      const ax = await send(
        'Accessibility.getPartialAXTree',
        { backendNodeId: ended.backendNodeId, fetchRelatives: false },
        ended.sessionId,
      );
      const axNode = ax?.nodes?.[0];
      if (axNode && !axNode.ignored) {
        role = typeof axNode.role?.value === 'string' ? axNode.role.value : '';
        accessibleName = typeof axNode.name?.value === 'string' ? axNode.name.value : '';
      }
    } catch (e) {
      log(`[element-picker] AX lookup degraded: ${(e as Error).message}`);
    }

    // 3) Border-box geometry (owning frame's viewport coords; transforms applied).
    let rect: PickedElement['rect'] = null;
    try {
      const box = await send('DOM.getBoxModel', { backendNodeId: ended.backendNodeId }, ended.sessionId);
      const quad: number[] | undefined = box?.model?.border;
      if (Array.isArray(quad) && quad.length === 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        rect = {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(Math.max(...xs) - x),
          height: Math.round(Math.max(...ys) - y),
        };
      }
    } catch {
      /* not rendered / no box — rect stays null */
    }

    // 4) Full outer→inner iframe ancestry. `leaf.frameChain` already holds the
    //    same-origin ancestors within the picked node's own session (inner→outer);
    //    when it did not reach the top, climb across OOPIF process boundaries: for
    //    each session, DOM.getFrameOwner on its PARENT session yields the <iframe>
    //    that hosts it, then walk that iframe's own same-origin ancestors,
    //    repeating to the root.
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
            { objectId: ownerObj.objectId, functionDeclaration: FRAME_OWNER_FN, returnByValue: true },
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
    const { markerOk, reachedTop: _rt, frameChain: _leafChain, ...rest } = leaf;
    const picked: PickedElement = {
      ...rest,
      role,
      accessibleName,
      marker: markerOk
        ? { attr: PICK_MARKER_ATTR, value: nonce, selector: `[${PICK_MARKER_ATTR}="${nonce}"]` }
        : null,
      rect,
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
