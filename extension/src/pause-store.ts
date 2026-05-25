/**
 * MementoPauseStore — durable PauseStore over `ExtensionContext.globalState`
 * per S4_DESIGN.md §3.
 *
 * Pure storage: does NOT flip context keys, fire events, or talk to the
 * SessionManager. SessionManager orchestrates the side effects after the
 * store's data has been written.
 *
 * S4_DESIGN.md §3.3 contract:
 *  - setActivePause clears any prior proposal slot.
 *  - proposeAction writes the proposal slot.
 *  - recordDecision (retry / give_up) clears the proposal slot atomically.
 *  - clearActivePause clears both keys.
 *
 * vscode.d.ts:8615 — Memento "value must be JSON-stringifyable".
 * vscode.d.ts:8617-8618 — passing undefined removes the key from storage.
 * vscode.d.ts:8623 — update() returns Thenable<void> (awaited).
 */

import * as vscode from 'vscode';

import {
  type PauseStore,
  type PauseStoreDisposable,
  type PausePayload,
  type Proposal,
  type ProposalKind,
  type AvailableChrome,
  type ChromeSelection,
  type ChromeSelectionSource,
  normalizePausePayload,
} from '@qa-debug/pause-store-types';
import { QaToolError } from '@qa-debug/tool-contracts/errors';

const KEY_ACTIVE = 'qa-debug.pause.active';
const KEY_PROPOSAL = 'qa-debug.pause.proposal';

export class MementoPauseStore implements PauseStore {
  private readonly chromeSelectedEmitter = new vscode.EventEmitter<ChromeSelection>();
  private readonly chromeDeselectedEmitter = new vscode.EventEmitter<string>();

  constructor(private readonly globalState: vscode.Memento) {}

  async setActivePause(p: PausePayload): Promise<void> {
    await this.globalState.update(KEY_ACTIVE, p);
    // S4_DESIGN.md §3.3: every new pause starts with a clean proposal slot.
    await this.globalState.update(KEY_PROPOSAL, undefined);
  }

  async clearActivePause(): Promise<void> {
    await this.globalState.update(KEY_ACTIVE, undefined);
    await this.globalState.update(KEY_PROPOSAL, undefined);
  }

  /** Returns the active pause without throwing, for boot-time stale-pause detection (§11). */
  peekActivePause(): PausePayload | undefined {
    // v5.16 PLAN-cdp-port-discovery §3.7 (H4) — normalize at the read site so
    // chat-participant + decision-router never see pre-v5.16 shapes (legacy
    // mode='A'/'B' pauses are migrated forward with available_chromes). Caller
    // discards diagnostics in the peek path; the throwing reader logs them.
    return normalizePausePayload(this.globalState.get(KEY_ACTIVE)).payload;
  }

  getActivePause(sessionId?: string): PausePayload | undefined {
    const { payload: active, diagnostics } = normalizePausePayload(
      this.globalState.get(KEY_ACTIVE),
    );
    if (diagnostics.length > 0) {
      console.warn(`[pause-store] normalize: ${diagnostics.join('; ')}`);
    }
    if (!active) {
      throw new QaToolError('NO_ACTIVE_PAUSE', 'No Mocha test is currently paused.');
    }
    if (sessionId && sessionId !== active.session_id) {
      throw new QaToolError(
        'SESSION_NOT_FOUND',
        `Supplied session_id "${sessionId}" does not match the active pause "${active.session_id}".`,
      );
    }
    return active;
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
    // Fire-and-forget the Thenable — proposals are best-effort durable; the
    // synchronous return makes the MCP tool handler respond immediately.
    // A reload before the write lands degrades to the stale-resume path (§11).
    void this.globalState.update(KEY_PROPOSAL, proposal);
    return proposal;
  }

  pollProposal(sessionId: string): Proposal | undefined {
    const proposal = this.globalState.get<Proposal>(KEY_PROPOSAL);
    if (!proposal) return undefined;
    // Defensive: cross-session orphans don't surface to the agent.
    if (proposal.session_id !== sessionId) return undefined;
    return proposal;
  }

  recordDecision(
    sessionId: string,
    kind: 'give_up',
    _reason: string,
  ): { decision: 'give_up'; accepted_at_ms: number } {
    this.getActivePause(sessionId);
    // S4_DESIGN.md §3.3 / §9.3 row 5: clear proposal atomically with decision.
    // Active pause stays — SessionManager clears it after the IPC round-trip.
    void this.globalState.update(KEY_PROPOSAL, undefined);
    return { decision: kind, accepted_at_ms: Date.now() };
  }

  // ---- v5.16 PLAN-cdp-port-discovery selection methods ----

  async recordChromeSelection(
    sessionId: string,
    port: number,
    source: ChromeSelectionSource,
  ): Promise<ChromeSelection> {
    const active = this.getActivePause(sessionId)!;
    const candidate = active.available_chromes.find((c) => c.port === port);
    if (!candidate) {
      throw new QaToolError(
        'INVALID_PORT',
        `Port ${port} is not in available_chromes (have: ${active.available_chromes
          .map((c) => c.port)
          .join(', ') || '<empty>'}). Call qa_discover_chromes first if framework ports changed.`,
      );
    }
    const updated: PausePayload = {
      ...active,
      selected_cdp_port: port,
    };
    await this.globalState.update(KEY_ACTIVE, updated);
    const selection: ChromeSelection = {
      session_id: active.session_id,
      port,
      cdp_ws_url: candidate.ws_url,
      page_titles: candidate.page_titles,
      source,
    };
    // Fire AFTER persistence resolves (§3.18 — session-manager must see
    // committed state when its subscriber runs).
    this.chromeSelectedEmitter.fire(selection);
    return selection;
  }

  async replaceAvailableChromes(
    sessionId: string,
    chromes: AvailableChrome[],
  ): Promise<{ cleared: boolean }> {
    const active = this.getActivePause(sessionId)!;
    const priorPort = active.selected_cdp_port;
    const priorInNewList =
      priorPort != null && chromes.some((c) => c.port === priorPort);
    const cleared = priorPort != null && !priorInNewList;
    const updated: PausePayload = {
      ...active,
      available_chromes: chromes,
      selected_cdp_port: cleared ? null : priorPort,
    };
    await this.globalState.update(KEY_ACTIVE, updated);
    if (cleared) {
      this.chromeDeselectedEmitter.fire(active.session_id);
    }
    return { cleared };
  }

  onChromeSelected(cb: (selection: ChromeSelection) => void): PauseStoreDisposable {
    return this.chromeSelectedEmitter.event(cb);
  }

  onChromeDeselected(cb: (sessionId: string) => void): PauseStoreDisposable {
    return this.chromeDeselectedEmitter.event(cb);
  }

  dispose(): void {
    this.chromeSelectedEmitter.dispose();
    this.chromeDeselectedEmitter.dispose();
  }
}
