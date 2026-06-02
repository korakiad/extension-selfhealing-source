/**
 * Shared PauseStore contract — types, interface, and the pure
 * `toFailureContextView` projection used by qa-debug-mcp tool handlers.
 *
 * Consumed by:
 *  - `qa-debug-mcp/` (stdio CLI; backs with InMemoryPauseStore for evals/Inspector)
 *  - `extension/`    (LM-tool host; backs with MementoPauseStore over
 *                     ExtensionContext.globalState)
 *
 * The PauseStore-error contract (NO_ACTIVE_PAUSE / SESSION_NOT_FOUND / etc.) is
 * owned by @qa-debug/tool-contracts/errors; this package only defines the data
 * shapes, the read/write surface, and the host-agnostic verb cores at the foot
 * of this file.
 */

/**
 * v5.16 — chrome lifecycle ownership.
 *  - 'framework' — test framework launched chrome (Mode C; only path in current use).
 *  - 'companion' — qa-debug-companion launched chrome (legacy migrated mode='B' only).
 * The companion never closes a framework-owned chrome; there is no close-browser
 * verb (the framework's own teardown disposes it).
 */
export type ChromeOwner = 'framework' | 'companion';

/**
 * Best-effort runtime label from /json/version User-Agent. `unknown` when the
 * UA is absent or app-overridden (Electron's app.userAgentFallback can strip
 * the "Electron" token). Behavior never depends on this label — `tab_count` is
 * the load-bearing multi-tab signal.
 */
export type ChromeRuntime = 'chrome' | 'electron' | 'openfin' | 'unknown';

/** v5.16 — single discovered chrome (browser-level CDP endpoint). */
export interface AvailableChrome {
  port: number;
  ws_url: string;        // browser-level ws://.../devtools/browser/<UUID>, normalized 0.0.0.0→127.0.0.1
  page_titles: string[]; // up to 5 from /json/list — used for picker UI / agent prompts
  // Count of `type==='page'` targets from /json/list;
  // the orient/tab-switch trigger (>1). Override-proof. /json/list fail → 1.
  tab_count: number;
  runtime: ChromeRuntime; // best-effort; see ChromeRuntime note above.
}

/** v5.16 — selection source for the diagnostic log. */
export type ChromeSelectionSource = 'agent' | 'extension-ui' | 'auto';

/** v5.16 — payload fired through onChromeSelected event AND returned from recordChromeSelection. */
export interface ChromeSelection {
  session_id: string;
  port: number;
  cdp_ws_url: string;
  page_titles: string[];
  source: ChromeSelectionSource;
}

export interface PausePayload {
  session_id: string;
  /** It()-only title (kept for Output Channel + UI label friendliness). */
  test_title: string;
  /**
   * v5.5 — canonical id key (Mocha Runnable.fullTitle()).
   */
  full_title: string;
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  /** v5.16 — discovered chromes via /json/version probe. */
  available_chromes: AvailableChrome[];
  /** v5.16 — null until qa_select_chrome / extension UI commits. */
  selected_cdp_port: number | null;
  /** v5.16 — lifecycle ownership. Always 'framework' on Mode C publish. */
  chrome_owner: ChromeOwner;
  screenshot_path?: string;
  console_logs: { lines: string[]; bytes: number; more_at?: string };
  paused_at_ms: number;
  retry_count: number;
  max_retries_remaining: number;
}

export interface FailureContextView {
  session_id: string;
  test_title: string;
  full_title: string;
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  /**
   * v5.16 — derived from selected_cdp_port + available_chromes.
   * Null until qa_select_chrome / extension UI commits a selection. Optional
   * in interface; consumers pre-v5.16 may not project this field.
   */
  cdp_ws_url?: string | null;
  /** v5.16 — exposed to agent so qa_get_failure_context can guide 3-branch picking. */
  available_chromes?: AvailableChrome[];
  /** v5.16 — null until selection. */
  selected_cdp_port?: number | null;
  screenshot_path?: string;
  console_logs: { lines: string[]; more_at?: string };
  paused_for_ms: number;
  retry_count: number;
  max_retries_remaining: number;
}

export type ResponseFormat = 'concise' | 'detailed';

/**
 * v5.16 — minimal Disposable shape compatible with both vscode.Disposable
 * (extension host) and node EventEmitter detach (stdio CLI). Implementations
 * own their event emitter; PauseStore consumers use the returned Disposable
 * to detach.
 */
export interface PauseStoreDisposable {
  dispose(): void;
}

/**
 * PauseStore — the contract every implementation must honour.
 *
 * `clearActivePause` is the SessionManager-driven step that runs after the
 * IPC round-trip completes.
 *
 * v5.16 additions: `recordChromeSelection` + `replaceAvailableChromes` mutate
 * the active pause's discovery/selection state. Fire `onChromeSelected` /
 * `onChromeDeselected` events AFTER persistence resolves so session-manager
 * wires playwright-mcp at the correct moment.
 */
export interface PauseStore {
  getActivePause(sessionId?: string): PausePayload | undefined;
  recordDecision(
    sessionId: string,
    kind: 'give_up',
    reason: string,
  ): { decision: 'give_up'; accepted_at_ms: number };

  /** v5.16 — commit a port from `available_chromes` as the active pause's chrome.
   *  Validates `port` is present in `available_chromes`; throws INVALID_PORT
   *  otherwise. Awaits persistence; fires `onChromeSelected` AFTER persist
   *  with the resolved ChromeSelection payload. */
  recordChromeSelection(
    sessionId: string,
    port: number,
    source: ChromeSelectionSource,
  ): Promise<ChromeSelection>;

  /** v5.16 — replace the active pause's discovered chromes (used by
   *  qa_discover_chromes after re-probe). Awaits persistence; if the prior
   *  selection's port is not in the new list, clears `selected_cdp_port`
   *  AND fires `onChromeDeselected(sessionId)`. Returns `{cleared: true}`
   *  when selection was cleared. */
  replaceAvailableChromes(
    sessionId: string,
    chromes: AvailableChrome[],
  ): Promise<{ cleared: boolean }>;

  /** v5.16 — subscribe to selection-committed events. Fires AFTER persistence. */
  onChromeSelected(cb: (selection: ChromeSelection) => void): PauseStoreDisposable;

  /** v5.16 — subscribe to selection-cleared events. Fires when
   *  `replaceAvailableChromes` clears a stale selection. */
  onChromeDeselected(cb: (sessionId: string) => void): PauseStoreDisposable;
}

export function toFailureContextView(
  active: PausePayload,
  format: ResponseFormat,
): FailureContextView {
  // v5.16 — derive cdp_ws_url from selection state. Null until
  // qa_select_chrome / extension UI commits a selection. The agent's
  // 3-branch picker in qa_get_failure_context reads available_chromes +
  // selected_cdp_port to drive the askUser flow.
  const selectedPort = active.selected_cdp_port;
  const selected =
    selectedPort != null
      ? active.available_chromes.find((c) => c.port === selectedPort)
      : undefined;
  const derivedCdpWsUrl = selected?.ws_url ?? null;
  const view: FailureContextView = {
    session_id: active.session_id,
    test_title: active.test_title,
    full_title: active.full_title,
    file: active.file,
    line: active.line,
    failing_assertion: active.failing_assertion,
    stack_trace: active.stack_trace,
    cdp_ws_url: derivedCdpWsUrl,
    available_chromes: active.available_chromes,
    selected_cdp_port: selectedPort,
    screenshot_path: active.screenshot_path,
    console_logs: {
      lines: active.console_logs.lines,
      more_at: active.console_logs.more_at,
    },
    paused_for_ms: Date.now() - active.paused_at_ms,
    retry_count: active.retry_count,
    max_retries_remaining: active.max_retries_remaining,
  };
  if (format === 'concise') {
    view.stack_trace = {
      frames: active.stack_trace.frames.slice(0, 10),
      more_at: active.stack_trace.more_at,
    };
    view.console_logs = {
      lines: active.console_logs.lines.slice(0, 20),
      more_at: active.console_logs.more_at,
    };
  }
  return view;
}

// ---- v5.16 — host-agnostic verb cores ----
// The extension LM-tool host and the stdio MCP host call these so the
// discover/select store logic + the NO_CHROMES_FOUND message live in one place.
// `probePorts` is injected (rather than imported) so this package stays a leaf
// — it does not depend on @qa-debug/mocha-hooks (where the probe lives). The
// NO_CHROMES_FOUND throw stays in each host (via QaToolError, which both already
// import) so this package also stays free of @qa-debug/tool-contracts; the core
// signals "none found" by returning an empty `available_chromes` WITHOUT having
// mutated the store (preserving the prior throw-before-replace behavior).

export type ProbePortsFn = (ports: readonly number[]) => Promise<AvailableChrome[]>;

export interface DiscoverChromesResult {
  available_chromes: AvailableChrome[];
  selection_cleared: boolean;
}

/**
 * Validate the session, re-probe `ports`, and (only when ≥1 chrome responded)
 * replace the pause's available_chromes. On an empty probe result the store is
 * left untouched and `selection_cleared` is false — the caller surfaces
 * NO_CHROMES_FOUND. `store.getActivePause` throws NO_ACTIVE_PAUSE /
 * SESSION_NOT_FOUND for a stale session before any network call.
 */
export async function discoverChromesCore(
  store: PauseStore,
  probePorts: ProbePortsFn,
  sessionId: string,
  ports: readonly number[],
): Promise<DiscoverChromesResult> {
  store.getActivePause(sessionId);
  const available_chromes = await probePorts(ports);
  if (available_chromes.length === 0) {
    return { available_chromes, selection_cleared: false };
  }
  const { cleared } = await store.replaceAvailableChromes(sessionId, available_chromes);
  return { available_chromes, selection_cleared: cleared };
}

/** Standard NO_CHROMES_FOUND message — shared so both hosts word it identically. */
export function noChromesFoundMessage(ports: readonly number[]): string {
  return (
    `None of the supplied ports [${ports.join(', ')}] responded to /json/version. ` +
    'Re-ask the user, or surface the framework launch failure.'
  );
}

export interface SelectChromeResult {
  cdp_ws_url: string;
  port: number;
  page_titles: string[];
}

/** Commit a chrome selection and project the host-facing result fields.
 *  `store.recordChromeSelection` validates the port (throws INVALID_PORT). */
export async function selectChromeCore(
  store: PauseStore,
  sessionId: string,
  port: number,
  source: ChromeSelectionSource = 'agent',
): Promise<SelectChromeResult> {
  const selection = await store.recordChromeSelection(sessionId, port, source);
  return {
    cdp_ws_url: selection.cdp_ws_url,
    port: selection.port,
    page_titles: selection.page_titles,
  };
}

/**
 * v5.16 — pure normalization for stored `PausePayload` blobs read from
 * untrusted-by-design storage (Memento or in-memory). Returns
 * `{payload, diagnostics}`; caller logs diagnostics.
 *
 * Migration table:
 *  - `available_chromes` present → no migration.
 *  - legacy `mode='A'`/`'B'` or bare `cdp_ws_url` → parse port from URL,
 *    rebuild as single-entry `available_chromes` with `selected_cdp_port`
 *    set; `chrome_owner='framework'` for A, `'companion'` otherwise.
 *  - none of the above → empty `available_chromes`, no selection.
 * v5.5 fallback: missing `full_title` → use `test_title` so stale-resume
 * doesn't crash on the version bump.
 */
export function normalizePausePayload(raw: unknown): {
  payload?: PausePayload;
  diagnostics: string[];
} {
  if (raw == null) return { diagnostics: [] };
  if (typeof raw !== 'object') {
    return { diagnostics: ['stored pause was non-object; treating as no active pause'] };
  }
  const obj = raw as Record<string, unknown>;
  const diagnostics: string[] = [];

  let available_chromes: AvailableChrome[] | undefined;
  let selected_cdp_port: number | null | undefined;
  let chrome_owner: ChromeOwner | undefined;

  if (Array.isArray(obj.available_chromes)) {
    // Default tab_count/runtime on pre-field stored data
    // so downstream readers (and the SKILL Step 1c trigger) always see the fields.
    available_chromes = (obj.available_chromes as Partial<AvailableChrome>[]).map((c) => ({
      port: c.port as number,
      ws_url: c.ws_url as string,
      page_titles: c.page_titles ?? [],
      tab_count: typeof c.tab_count === 'number' ? c.tab_count : (c.page_titles?.length || 1),
      runtime: c.runtime ?? 'unknown',
    }));
    selected_cdp_port =
      typeof obj.selected_cdp_port === 'number' ? (obj.selected_cdp_port as number) : null;
    chrome_owner = (obj.chrome_owner as ChromeOwner | undefined) ?? 'framework';
  } else if (typeof obj.cdp_ws_url === 'string') {
    const match = obj.cdp_ws_url.match(/ws:\/\/[^:/]+:(\d+)\//);
    if (match) {
      const port = Number(match[1]);
      available_chromes = [
        { port, ws_url: obj.cdp_ws_url, page_titles: [], tab_count: 1, runtime: 'unknown' },
      ];
      selected_cdp_port = port;
      chrome_owner = obj.mode === 'A' ? 'framework' : 'companion';
      diagnostics.push(
        `migrated legacy pause (mode=${obj.mode ?? 'unset'}) → port=${port}, chrome_owner=${chrome_owner}`,
      );
    } else {
      available_chromes = [];
      selected_cdp_port = null;
      chrome_owner = 'framework';
      diagnostics.push(`legacy cdp_ws_url did not parse a port; cleared selection`);
    }
  } else {
    available_chromes = [];
    selected_cdp_port = null;
    chrome_owner = 'framework';
  }

  const full_title =
    typeof obj.full_title === 'string'
      ? (obj.full_title as string)
      : typeof obj.test_title === 'string'
        ? (obj.test_title as string)
        : '';

  const payload: PausePayload = {
    ...(obj as unknown as PausePayload),
    full_title,
    available_chromes,
    selected_cdp_port: selected_cdp_port ?? null,
    chrome_owner,
  };
  // Strip legacy keys so downstream readers never see them.
  delete (payload as unknown as Record<string, unknown>).cdp_ws_url;
  delete (payload as unknown as Record<string, unknown>).mode;

  return { payload, diagnostics };
}
