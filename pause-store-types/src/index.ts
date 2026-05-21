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

export type ProposalKind = 'mark_passed' | 'close_browser' | 'abort_suite';
export type ProposalStatus = 'none' | 'awaiting_human' | 'accepted' | 'rejected';

/**
 * v5.2 §2.4 browser-ownership mode for the pause's investigation surface.
 *  - 'A' — user's wdio.remote() launched the browser; user owns lifecycle.
 *  - 'B' — extension launched headed Chrome at :9222; extension owns lifecycle.
 * qa_propose_close_browser declines in Mode A per §2.6.
 */
export type BrowserOwnershipMode = 'A' | 'B';

export interface PausePayload {
  session_id: string;
  test_title: string;
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  cdp_ws_url: string;
  /** v5.2 §2.4: defaults to 'B' for back-compat with pre-v5.2 stored pauses. */
  mode?: BrowserOwnershipMode;
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
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  cdp_ws_url: string;
  screenshot_path?: string;
  console_logs: { lines: string[]; more_at?: string };
  paused_for_ms: number;
  retry_count: number;
  max_retries_remaining: number;
  last_proposal_status: ProposalStatus;
}

export type ResponseFormat = 'concise' | 'detailed';

/**
 * PauseStore — the contract every implementation must honour.
 *
 * S4 contract addition per S4_DESIGN.md §3.3: `recordDecision` for
 * `retry`/`give_up` clears the proposal slot atomically with the decision
 * record, closing the orphan-proposal window when an agent calls
 * `qa_propose_mark_passed` then immediately `qa_request_retry`.
 * `clearActivePause` is the SessionManager-driven step that runs after the
 * IPC round-trip completes (per S4_DESIGN.md §3.3 / §9.3).
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
    kind: 'retry' | 'give_up',
    reason: string,
  ): { decision: 'retry' | 'give_up'; accepted_at_ms: number };
}

export function toFailureContextView(
  active: PausePayload,
  proposal: Proposal | undefined,
  format: ResponseFormat,
): FailureContextView {
  const view: FailureContextView = {
    session_id: active.session_id,
    test_title: active.test_title,
    file: active.file,
    line: active.line,
    failing_assertion: active.failing_assertion,
    stack_trace: active.stack_trace,
    cdp_ws_url: active.cdp_ws_url,
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
