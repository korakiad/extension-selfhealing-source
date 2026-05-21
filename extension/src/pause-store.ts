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

import type * as vscode from 'vscode';

import {
  type PauseStore,
  type PausePayload,
  type Proposal,
  type ProposalKind,
} from '@qa-debug/pause-store-types';
import { QaToolError } from '@qa-debug/qa-debug-mcp/pause-store';

const KEY_ACTIVE = 'qa-debug.pause.active';
const KEY_PROPOSAL = 'qa-debug.pause.proposal';

export class MementoPauseStore implements PauseStore {
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
    return this.globalState.get<PausePayload>(KEY_ACTIVE);
  }

  getActivePause(sessionId?: string): PausePayload | undefined {
    const active = this.globalState.get<PausePayload>(KEY_ACTIVE);
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
    kind: 'retry' | 'give_up',
    _reason: string,
  ): { decision: 'retry' | 'give_up'; accepted_at_ms: number } {
    this.getActivePause(sessionId);
    // S4_DESIGN.md §3.3 / §9.3 row 5: clear proposal atomically with decision.
    // Active pause stays — SessionManager clears it after the IPC round-trip.
    void this.globalState.update(KEY_PROPOSAL, undefined);
    return { decision: kind, accepted_at_ms: Date.now() };
  }
}
