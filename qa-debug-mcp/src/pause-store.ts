/**
 * In-memory `PauseStore` stub used by the stdio CLI (`bin/stdio.ts`) for
 * Inspector smoke runs and by the `evals/` engagement harness. The shared
 * interface + payload types + `toFailureContextView` projection live in
 * `@qa-debug/pause-store-types` (extracted in S4).
 *
 * The S4 extension swaps this for `MementoPauseStore` via constructor DI
 * when it hosts the qa-debug MCP server in-process over Streamable HTTP.
 */

import { EventEmitter } from 'node:events';

import {
  type PauseStore,
  type PauseStoreDisposable,
  type PausePayload,
  type Proposal,
  type ProposalKind,
  type AvailableChrome,
  type ChromeSelection,
  type ChromeSelectionSource,
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
  // v5.16 — node EventEmitter parity with MementoPauseStore's vscode.EventEmitter
  // (PLAN §3.7: both impls fire-after-persist; synchronous here, async there).
  private readonly chromeEvents = new EventEmitter();

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
    kind: 'give_up',
    _reason: string,
  ): { decision: 'give_up'; accepted_at_ms: number } {
    const active = this.getActivePause(sessionId)!;
    // S4 contract per S4_DESIGN.md §3.3 + §9.3 row 5: recordDecision for
    // retry/give_up clears the proposal slot atomically, closing the
    // orphan-proposal window. The active pause stays — SessionManager
    // clears it after the IPC round-trip in the extension; the in-memory
    // stub's caller (oracle / Inspector smoke) clears separately if needed.
    this.proposals.delete(active.session_id);
    return { decision: kind, accepted_at_ms: Date.now() };
  }

  // ---- v5.16 PLAN-cdp-port-discovery selection methods ----

  async recordChromeSelection(
    sessionId: string,
    port: number,
    source: ChromeSelectionSource,
  ): Promise<ChromeSelection> {
    const active = this.getActivePause(sessionId)!;
    const candidate = (active.available_chromes ?? []).find((c) => c.port === port);
    if (!candidate) {
      throw new QaToolError(
        'INVALID_PORT',
        `Port ${port} is not in available_chromes (have: ${(active.available_chromes ?? [])
          .map((c) => c.port)
          .join(', ') || '<empty>'}). Call qa_discover_chromes first if framework ports changed.`,
      );
    }
    this.active = {
      ...active,
      selected_cdp_port: port,
      cdp_ws_url: candidate.ws_url,
    };
    const selection: ChromeSelection = {
      session_id: active.session_id,
      port,
      cdp_ws_url: candidate.ws_url,
      page_titles: candidate.page_titles,
      source,
    };
    this.chromeEvents.emit('selected', selection);
    return selection;
  }

  async replaceAvailableChromes(
    sessionId: string,
    chromes: AvailableChrome[],
  ): Promise<{ cleared: boolean }> {
    const active = this.getActivePause(sessionId)!;
    const priorPort = active.selected_cdp_port ?? null;
    const priorInNewList =
      priorPort != null && chromes.some((c) => c.port === priorPort);
    const cleared = priorPort != null && !priorInNewList;
    this.active = {
      ...active,
      available_chromes: chromes,
      selected_cdp_port: cleared ? null : priorPort,
      cdp_ws_url: cleared
        ? chromes[0]?.ws_url ?? active.cdp_ws_url
        : active.cdp_ws_url,
    };
    if (cleared) {
      this.chromeEvents.emit('deselected', active.session_id);
    }
    return { cleared };
  }

  onChromeSelected(cb: (selection: ChromeSelection) => void): PauseStoreDisposable {
    this.chromeEvents.on('selected', cb);
    return { dispose: () => this.chromeEvents.off('selected', cb) };
  }

  onChromeDeselected(cb: (sessionId: string) => void): PauseStoreDisposable {
    this.chromeEvents.on('deselected', cb);
    return { dispose: () => this.chromeEvents.off('deselected', cb) };
  }
}
