/**
 * Sidecar JSONL audit file written at deactivate() when a pause was still
 * active. Lives at `${context.globalStorageUri}/audit.jsonl`.
 *
 * Phase 1 trade-off (per PLAN-clean-shutdown-sentinel.md [R#NB6]):
 * non-atomic write (read-existing + concat + write). Acceptable because the
 * only writer fires from `deactivate()` — single-writer, no concurrent
 * contention; the crash window is microseconds during `fs.writeFile`.
 * Tmpfile+rename is a Phase-2 polish target.
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

export async function appendDeactivateAudit(
  globalStorageUri: vscode.Uri,
  pause: PausePayload,
): Promise<void> {
  await vscode.workspace.fs.createDirectory(globalStorageUri);
  const auditUri = vscode.Uri.joinPath(globalStorageUri, AUDIT_FILE_NAME);
  const entry: DeactivateAuditEntry = {
    ts: new Date().toISOString(),
    kind: 'deactivate-with-active-pause',
    session_id: pause.session_id,
    test_title: pause.test_title,
    file: pause.file,
    line: pause.line,
    paused_at_ms: pause.paused_at_ms,
  };
  const line = JSON.stringify(entry) + '\n';

  let existing = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(auditUri);
    existing = new TextDecoder().decode(bytes);
  } catch {
    // File doesn't exist yet — first deactivate-with-active-pause ever.
  }
  const next = new TextEncoder().encode(existing + line);
  await vscode.workspace.fs.writeFile(auditUri, next);
}
