/**
 * In-memory `PauseStore` stub used by the stdio CLI (`bin/stdio.ts`) for
 * Inspector smoke runs and by the `evals/` engagement harness. The shared
 * interface + payload types + `toFailureContextView` projection live in
 * `@qa-debug/pause-store-types` (extracted in S4).
 *
 * The S4 extension swaps this for `MementoPauseStore` via constructor DI
 * when it hosts the qa-debug MCP server in-process over Streamable HTTP.
 */

import {
  type PauseStore,
  type PausePayload,
  type Proposal,
  type ProposalKind,
} from '@qa-debug/pause-store-types';
import { QaToolError } from '@qa-debug/tool-contracts/errors';

export {
  type PauseStore,
  type PausePayload,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type FailureContextView,
  type ResponseFormat,
  toFailureContextView,
} from '@qa-debug/pause-store-types';
export { QaToolError, type QaErrorCode } from '@qa-debug/tool-contracts/errors';

/** S3 in-memory stub; S4 swaps for `MementoPauseStore` in the extension. */
export class InMemoryPauseStore implements PauseStore {
  private active?: PausePayload;
  private proposals = new Map<string, Proposal>();

  setActivePause(p: PausePayload): void {
    this.active = p;
    // S4 contract: setActivePause clears any prior proposal slot
    // (per S4_DESIGN.md §3.3 — every new pause starts clean).
    this.proposals.clear();
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
    const active = this.getActivePause(sessionId)!;
    // S4 contract per S4_DESIGN.md §3.3 + §9.3 row 5: recordDecision for
    // retry/give_up clears the proposal slot atomically, closing the
    // orphan-proposal window. The active pause stays — SessionManager
    // clears it after the IPC round-trip in the extension; the in-memory
    // stub's caller (oracle / Inspector smoke) clears separately if needed.
    this.proposals.delete(active.session_id);
    return { decision: kind, accepted_at_ms: Date.now() };
  }
}
