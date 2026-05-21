import { QaToolError } from './errors.js';

export type ProposalKind = 'mark_passed' | 'close_browser' | 'abort_suite';
export type ProposalStatus = 'none' | 'awaiting_human' | 'accepted' | 'rejected';

export interface PausePayload {
  session_id: string;
  test_title: string;
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  cdp_ws_url: string;
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

/** S3 in-memory stub. S4 swaps for an extension-backed store via DI. */
export class InMemoryPauseStore implements PauseStore {
  private active?: PausePayload;
  private proposals = new Map<string, Proposal>();

  setActivePause(p: PausePayload): void {
    this.active = p;
  }

  clearActivePause(): void {
    this.active = undefined;
    this.proposals.clear();
  }

  getActivePause(sessionId?: string): PausePayload | undefined {
    if (!this.active) {
      throw new QaToolError('NO_ACTIVE_PAUSE', 'No Mocha test is currently paused.');
    }
    if (sessionId && sessionId !== this.active.session_id) {
      throw new QaToolError(
        'SESSION_NOT_FOUND',
        `Supplied session_id "${sessionId}" does not match the active pause "${this.active.session_id}".`,
      );
    }
    return this.active;
  }

  proposeAction(sessionId: string, kind: ProposalKind, rationale: string): Proposal {
    const active = this.getActivePause(sessionId)!;
    const proposal: Proposal = {
      proposal_id: `${kind}-${active.session_id}-${Date.now()}`,
      session_id: active.session_id,
      kind,
      rationale,
      status: 'awaiting_human',
      created_at_ms: Date.now(),
    };
    this.proposals.set(active.session_id, proposal);
    return proposal;
  }

  pollProposal(sessionId: string): Proposal | undefined {
    return this.proposals.get(sessionId);
  }

  recordDecision(
    sessionId: string,
    kind: 'retry' | 'give_up',
    _reason: string,
  ): { decision: 'retry' | 'give_up'; accepted_at_ms: number } {
    this.getActivePause(sessionId);
    return { decision: kind, accepted_at_ms: Date.now() };
  }
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
