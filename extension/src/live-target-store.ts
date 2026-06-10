/**
 * LiveTargetStore — in-memory state for the active Live Inspect Session's CDP
 * target. Deliberately NOT a synthetic PausePayload (would pollute
 * failure-context readers); it holds only the chrome sub-shape the picker reads.
 *
 * In-memory (not Memento): a live session is bound to a launched browser this
 * ext-host owns; it must not survive a reload (the browser would be reaped).
 */

import type { AvailableChrome } from '@qa-debug/pause-store-types';

export interface LiveTarget {
  /** "live-<uuid>"; distinct namespace from pause session ids. */
  session_id: string;
  available_chromes: AvailableChrome[];
  /** The launched browser's port; auto-selected at launch (rarely null). */
  selected_cdp_port: number | null;
}

export class LiveTargetStore {
  private target: LiveTarget | undefined;

  set(t: LiveTarget): void {
    this.target = t;
  }
  clear(): void {
    this.target = undefined;
  }
  get(): LiveTarget | undefined {
    return this.target;
  }
}
