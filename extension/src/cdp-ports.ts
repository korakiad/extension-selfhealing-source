/**
 * Resolves the CDP port POOL the Live Inspect Session launcher allocates from
 * (and qa_start_live_session re-probes). Read from `qaDebug.cdpPorts`; one port
 * is claimed per concurrent inspect session across all windows, so the pool size
 * bounds simultaneous launches. Defaults match the org's framework convention
 * plus headroom for several parallel projects.
 *
 * NOTE: the mocha-child Mode-C discovery keeps its OWN `QA_DEBUG_CDP_PORTS` env
 * path (mocha-hooks/qa-hooks.ts) — that runs in the child, not the ext host.
 * This setting is the ext-host read path only.
 */

import * as vscode from 'vscode';

export const DEFAULT_CDP_PORTS: readonly number[] = [22135, 22136, 22137, 22138, 22139];

/** Configured pool, validated (1024-65535, integer). Falls back to defaults. */
export function getCdpPorts(): number[] {
  const raw = vscode.workspace.getConfiguration('qaDebug').get<number[]>('cdpPorts');
  if (!Array.isArray(raw)) return [...DEFAULT_CDP_PORTS];
  const valid = raw.filter((n) => Number.isInteger(n) && n >= 1024 && n <= 65535);
  return valid.length > 0 ? valid : [...DEFAULT_CDP_PORTS];
}
