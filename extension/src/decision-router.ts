/**
 * DecisionRouter — holds the single in-flight `decision.await` callback per
 * session_id and routes UI-button / agent-tool commits to it.
 *
 * Single-shot semantics; mocha-crash-during-await synthesis; the agent/human
 * race observations.
 */

import type * as vscode from 'vscode';

import type { DecisionBy, DecisionKind, DecisionResult } from '@qa-debug/mocha-hooks/protocol';

import { appendInfo } from './output-channel.js';

type Pending = (decision: DecisionResult) => void;

export class DecisionRouter {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly auditChannel: vscode.OutputChannel) {}

  enroll(sessionId: string, resolve: Pending): void {
    if (this.pending.has(sessionId)) {
      // Should not happen — each pause has a unique session_id. If it does,
      // the prior caller is orphaned. Log + replace.
      appendInfo(this.auditChannel, `[decision-router] overwrote pending callback for session=${sessionId}`);
    }
    this.pending.set(sessionId, resolve);
  }

  /**
   * Single-shot commit. Returns false if no pending callback exists for the
   * sessionId (already-committed or never-enrolled). Tool handlers and UI
   * commands surface a false return as NO_ACTIVE_PAUSE.
   */
  commit(sessionId: string, kind: DecisionKind, reason: string, by: DecisionBy): boolean {
    const p = this.pending.get(sessionId);
    if (!p) {
      appendInfo(
        this.auditChannel,
        `[decision-router] race: dropped ${kind} by ${by} (session=${sessionId} already resolved)`,
      );
      return false;
    }
    this.pending.delete(sessionId);
    p({ kind, reason, by });
    return true;
  }

  /** Synthesizes give_up. Used by the mocha-crash path and stale-resume. */
  abandon(sessionId: string, reason: string, by: DecisionBy = 'hook'): boolean {
    return this.commit(sessionId, 'give_up', reason, by);
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }
}
