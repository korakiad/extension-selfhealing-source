/**
 * resolveInspectTarget — the single chrome-target resolver the generalized
 * picker uses. Returns the active inspection's chrome sub-shape from EITHER a
 * Mocha pause OR a Live Inspect Session (they are mutually exclusive per the
 * InspectionArbiter, so at most one is set). Throws NO_ACTIVE_INSPECTION when
 * neither exists, SESSION_NOT_FOUND when an explicit session_id matches neither.
 */

import type { AvailableChrome } from '@qa-debug/pause-store-types';
import { QaToolError } from '@qa-debug/tool-contracts/errors';

import type { LiveTargetStore } from '../live-target-store.js';
import type { MementoPauseStore } from '../pause-store.js';

export interface InspectTarget {
  session_id: string;
  available_chromes: AvailableChrome[];
  selected_cdp_port: number | null;
  kind: 'pause' | 'live';
}

export function resolveInspectTarget(
  pauseStore: MementoPauseStore,
  liveTargetStore: LiveTargetStore,
  sessionId?: string,
): InspectTarget {
  const candidates: InspectTarget[] = [];
  const live = liveTargetStore.get();
  if (live) {
    candidates.push({
      session_id: live.session_id,
      available_chromes: live.available_chromes,
      selected_cdp_port: live.selected_cdp_port,
      kind: 'live',
    });
  }
  // peekActivePause() never throws (unlike getActivePause), so a missing pause
  // doesn't mask a live session.
  const pause = pauseStore.peekActivePause();
  if (pause) {
    candidates.push({
      session_id: pause.session_id,
      available_chromes: pause.available_chromes,
      selected_cdp_port: pause.selected_cdp_port,
      kind: 'pause',
    });
  }

  if (candidates.length === 0) {
    throw new QaToolError(
      'NO_ACTIVE_INSPECTION',
      'No Mocha test is paused and no Live Inspect Session is active. ' +
        'Launch one via the "QA Debug: Inspect App" command (status bar) first.',
    );
  }
  if (sessionId) {
    const match = candidates.find((c) => c.session_id === sessionId);
    if (!match) {
      throw new QaToolError(
        'SESSION_NOT_FOUND',
        `Supplied session_id "${sessionId}" does not match the active inspection.`,
      );
    }
    return match;
  }
  // Arbiter guarantees mutual exclusion, so there is at most one candidate; the
  // order (live first) is only a defensive tiebreak.
  return candidates[0];
}
