/**
 * Shared PauseStore contract — types, interface, and the pure
 * `toFailureContextView` projection used by qa-debug-mcp tool handlers.
 *
 * Consumed by:
 *  - `qa-debug-mcp/` (S3 stdio CLI; backs with InMemoryPauseStore for evals/Inspector)
 *  - `extension/`    (S4 in-extension MCP host; backs with MementoPauseStore over
 *                     ExtensionContext.globalState)
 *
 * The PauseStore-error contract (NO_ACTIVE_PAUSE / SESSION_NOT_FOUND) is owned
 * by qa-debug-mcp/src/errors.ts; this package only defines the data shapes and
 * read/write surface.
 */

export type ProposalKind = 'mark_passed' | 'abort_suite';
export type ProposalStatus = 'none' | 'awaiting_human' | 'accepted' | 'rejected';

/**
 * v5.16 PLAN-cdp-port-discovery — chrome lifecycle ownership.
 *  - 'framework' — test framework launched chrome (Mode C; only path in current PLAN).
 *  - 'companion' — qa-debug-companion launched chrome (legacy migrated mode='B' only).
 * qa_propose_close_browser declines on 'framework' per propose-close-browser.ts.
 */
export type ChromeOwner = 'framework' | 'companion';

/** v5.16 — single discovered chrome (browser-level CDP endpoint). */
export interface AvailableChrome {
  port: number;
  ws_url: string;        // browser-level ws://.../devtools/browser/<UUID>, normalized 0.0.0.0→127.0.0.1
  page_titles: string[]; // up to 5 from /json/list — used for picker UI / agent prompts
}

/** v5.16 — selection source for §3.4 diagnostic log. */
export type ChromeSelectionSource = 'agent' | 'extension-ui' | 'auto';

/** v5.16 — payload fired through onChromeSelected event AND returned from recordChromeSelection. */
export interface ChromeSelection {
  session_id: string;
  port: number;
  cdp_ws_url: string;
  page_titles: string[];
  source: ChromeSelectionSource;
}

/**
 * @deprecated v5.16 transitional — will be removed once all readers migrate to
 * `selected_cdp_port`/`available_chromes`. Maps to `ChromeOwner` going forward:
 *   'A' → 'framework' (Mode A pauses are user-test-code-owned)
 *   'B' → 'companion' (Mode B pauses are companion-owned)
 */
export type BrowserOwnershipMode = 'A' | 'B';

export interface PausePayload {
  session_id: string;
  /** It()-only title (kept for Output Channel + UI label friendliness). */
  test_title: string;
  /**
   * v5.5 §2.4 — canonical id key (Mocha Runnable.fullTitle()).
   */
  full_title: string;
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  /**
   * v5.16 transitional — primary chrome's ws_url, populated EITHER from legacy
   * Mode A/B publish OR from `available_chromes[0]?.ws_url` during the migration.
   * @deprecated callers should migrate to deriving from `available_chromes` + `selected_cdp_port`.
   */
  cdp_ws_url: string;
  /** @deprecated v5.2 transitional. Maps to `chrome_owner`. */
  mode?: BrowserOwnershipMode;
  /** v5.16 — discovered chromes via /json/version probe. Optional during migration; required post-v5.16. */
  available_chromes?: AvailableChrome[];
  /** v5.16 — null until qa_select_chrome / extension UI commits. Optional during migration. */
  selected_cdp_port?: number | null;
  /** v5.16 — lifecycle ownership. Optional during migration; derives from `mode` legacy field if absent. */
  chrome_owner?: ChromeOwner;
  screenshot_path?: string;
  console_logs: { lines: string[]; bytes: number; more_at?: string };
  paused_at_ms: number;
  retry_count: number;
  max_retries_remaining: number;
}

export interface Proposal {
  proposal_id: string;
  session_id: string;
  kind: ProposalKind;
  rationale: string;
  status: Exclude<ProposalStatus, 'none'>;
  created_at_ms: number;
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
   * v5.16 — derived from selected_cdp_port + available_chromes; falls back to legacy
   * `PausePayload.cdp_ws_url` during migration. Optional in interface; consumers
   * pre-v5.16 may not project this field.
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
  last_proposal_status: ProposalStatus;
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
 * S4 contract addition per S4_DESIGN.md §3.3: `recordDecision` for
 * `retry`/`give_up` clears the proposal slot atomically with the decision
 * record, closing the orphan-proposal window when an agent calls
 * `qa_propose_mark_passed` then immediately `qa_request_retry`.
 * `clearActivePause` is the SessionManager-driven step that runs after the
 * IPC round-trip completes (per S4_DESIGN.md §3.3 / §9.3).
 *
 * v5.16 PLAN-cdp-port-discovery additions: `recordChromeSelection` +
 * `replaceAvailableChromes` mutate the active pause's discovery/selection
 * state. Fire `onChromeSelected` / `onChromeDeselected` events AFTER
 * persistence resolves so session-manager wires playwright-mcp at the
 * correct moment (§3.18).
 */
export interface PauseStore {
  getActivePause(sessionId?: string): PausePayload | undefined;
  proposeAction(
    sessionId: string,
    kind: ProposalKind,
    rationale: string,
  ): Proposal;
  pollProposal(sessionId: string): Proposal | undefined;
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
  proposal: Proposal | undefined,
  format: ResponseFormat,
): FailureContextView {
  // v5.16 — derive cdp_ws_url from selection state (PLAN §3.2). The
  // selected port wins; otherwise fall back to the legacy `cdp_ws_url`
  // field still populated by qa-hooks for the transition period. Mode C
  // pauses with no selection committed surface `null` so the agent's
  // 3-branch picker in qa_get_failure_context can ask the user.
  const selectedPort = active.selected_cdp_port ?? null;
  const selected =
    selectedPort != null
      ? active.available_chromes?.find((c) => c.port === selectedPort)
      : undefined;
  const derivedCdpWsUrl =
    selected?.ws_url ?? (active.available_chromes && active.available_chromes.length > 0 ? null : active.cdp_ws_url ?? null);
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
    last_proposal_status: proposal?.status ?? 'none',
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

/**
 * v5.5 §2.4 / NB5 / Q4 — defensive normalization for `PausePayload` blobs
 * read from untrusted-by-design storage (e.g., MementoPauseStore over
 * `ExtensionContext.globalState`). Pre-v5.5 stored pauses lack `full_title`;
 * fall back to `test_title` so stale-resume + Give Up flows do not crash on
 * the version bump. Returns undefined for non-object input (defaults the
 * `peekActivePause()` empty case).
 */
export function normalizeStoredPause(raw: unknown): PausePayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.full_title === 'string') {
    return obj as unknown as PausePayload;
  }
  const test_title = typeof obj.test_title === 'string' ? obj.test_title : '';
  return { ...obj, full_title: test_title } as unknown as PausePayload;
}
