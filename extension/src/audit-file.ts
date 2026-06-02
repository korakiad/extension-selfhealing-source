/**
 * Sidecar JSONL audit file written at deactivate() OR activate() when a pause
 * was still active. Lives at `${context.globalStorageUri}/audit.jsonl`.
 *
 * Two entry kinds:
 *  - `deactivate-with-active-pause` — written from `deactivate()` when the
 *    extension is shutting down with an unresolved pause.
 *  - `orphan-pause-at-activate` — written from `activate()` when a Memento
 *    pause entry was leftover from a prior extension-host instance.
 *
 * Dual-write hazard: if `deactivate()` writes a `deactivate-with-active-pause`
 * line then is `SIGKILL`'d before the Memento `clearActivePause` flushes, the
 * next `activate()` writes an additional `orphan-pause-at-activate` line for
 * the same `session_id`. Consumers of `audit.jsonl` should dedupe by
 * `(session_id, latest kind)` if they need one row per pause.
 *
 * Schema-evolution rule: changes to either entry shape must be additive only
 * (new optional fields). Removing or renaming a field breaks downstream
 * consumers that read older lines from the same file.
 *
 * Phase 1 trade-off: non-atomic write (read-existing + concat + write).
 * Single-writer per call site, no concurrent contention; the crash window is
 * microseconds during `fs.writeFile`. Tmpfile+rename is a Phase-2 polish
 * target.
 *
 * Phase 2 follow-ups:
 *  - Tmpfile+rename for atomicity.
 *  - File rotation cap (e.g., 10MB → archive). Phase-1 growth rate is
 *    <1 line/day for heavy users (~50KB/year @ ~140 bytes/line), so this
 *    is deferred without scheduling pressure.
 *  - `qa-debug.showHistory` command surfacing this file in VS Code UI.
 */

import * as vscode from 'vscode';

import type { PausePayload } from '@qa-debug/pause-store-types';

const AUDIT_FILE_NAME = 'audit.jsonl';

interface DeactivateAuditEntry {
  ts: string;
  kind: 'deactivate-with-active-pause';
  session_id: string;
  test_title: string;
  file: string;
  line: number | undefined;
  paused_at_ms: number;
}

interface OrphanPauseAuditEntry {
  ts: string;
  kind: 'orphan-pause-at-activate';
  session_id: string;
  test_title: string;
  file: string;
  line: number | undefined;
  paused_at_ms: number;
  // Reserved for future provenance: in v5.11 the `qa-debug.clean_shutdown`
  // sentinel was removed, so no producer writes `true` here yet. The field
  // stays in the schema so a future crash-detection signal can fill it
  // without breaking the consumer contract.
  prior_clean_shutdown_sentinel: boolean;
}

async function appendJsonLine(
  globalStorageUri: vscode.Uri,
  line: string,
): Promise<void> {
  await vscode.workspace.fs.createDirectory(globalStorageUri);
  const auditUri = vscode.Uri.joinPath(globalStorageUri, AUDIT_FILE_NAME);
  let existing = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(auditUri);
    existing = new TextDecoder().decode(bytes);
  } catch {
    // File doesn't exist yet — first audit entry ever.
  }
  const next = new TextEncoder().encode(existing + line);
  await vscode.workspace.fs.writeFile(auditUri, next);
}

export async function appendDeactivateAudit(
  globalStorageUri: vscode.Uri,
  pause: PausePayload,
): Promise<void> {
  const entry: DeactivateAuditEntry = {
    ts: new Date().toISOString(),
    kind: 'deactivate-with-active-pause',
    session_id: pause.session_id,
    test_title: pause.test_title,
    file: pause.file,
    line: pause.line,
    paused_at_ms: pause.paused_at_ms,
  };
  await appendJsonLine(globalStorageUri, JSON.stringify(entry) + '\n');
}

export async function appendOrphanPauseAudit(
  globalStorageUri: vscode.Uri,
  pause: PausePayload,
): Promise<void> {
  const entry: OrphanPauseAuditEntry = {
    ts: new Date().toISOString(),
    kind: 'orphan-pause-at-activate',
    session_id: pause.session_id,
    test_title: pause.test_title,
    file: pause.file,
    line: pause.line,
    paused_at_ms: pause.paused_at_ms,
    prior_clean_shutdown_sentinel: false,
  };
  await appendJsonLine(globalStorageUri, JSON.stringify(entry) + '\n');
}
