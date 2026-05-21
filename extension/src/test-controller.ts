/**
 * TestController integration — renders pauses and decisions in Test Explorer
 * per S4_DESIGN §7.
 *
 * Tri-state mapping (§7.2 [R#2-B1]):
 *   passed         → run.passed
 *   failed         → run.failed (already in that state from pause-publish)
 *   marked-passed  → keep the failed TestMessage attached + set description
 *                    '(marked passed)' + transition run.passed + appendOutput
 *                    rationale row. This preserves ARCHITECTURE §3.6 line 273
 *                    commitment that the rendering distinguishes from a plain
 *                    pass. TestMessage retention behavior is verified at
 *                    implementation time per §7.2 R#3-NB1 (pre-PR screenshot).
 *
 * TestItem id formula (§7.3 NB#10): `${fileUri.toString()}::${testTitle}` —
 * stable across retry respawns so the same TestItem receives subsequent
 * pause/decision events for the same logical test.
 */

import * as vscode from 'vscode';
import path from 'node:path';

import type { PausePayload } from '@qa-debug/pause-store-types';
import type { FinalDecisionParams } from '@qa-debug/mocha-hooks/protocol';

import { appendDecision, appendInfo } from './output-channel.js';

export interface TestRunHandle {
  /** Lazy-create or look up the TestItem for a paused test; mark it failed with the inline buttons. */
  recordPause(pause: PausePayload): void;
  /** Apply tri-state outcome from a final_decision notification. */
  recordDecision(decision: FinalDecisionParams, pause: PausePayload | undefined): void;
  /** Mocha exited; flush the run. */
  end(): void;
}

export interface TestControllerWrapper {
  controller: vscode.TestController;
  /** Begin a new run; returns a handle scoped to this suite invocation. */
  beginRun(name?: string): TestRunHandle;
}

export function createTestControllerWrapper(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  startSuiteRun: () => Promise<void> | void,
): TestControllerWrapper {
  const controller = vscode.tests.createTestController('qa-debug-tests', 'QA Debug Companion');
  context.subscriptions.push(controller);

  // One Run profile, defaultable. The handler delegates to SessionManager
  // (passed in via startSuiteRun) which owns the mocha+chrome lifecycle.
  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    async (_request, _token) => {
      try {
        await startSuiteRun();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendInfo(channel, `[test-controller] suite run failed: ${msg}`);
      }
    },
    /* isDefault */ true,
  );

  return {
    controller,
    beginRun: (name?: string): TestRunHandle => {
      const request = new vscode.TestRunRequest();
      const run = controller.createTestRun(request, name, /* persist */ true);
      const items = new Map<string, vscode.TestItem>(); // id → TestItem
      const failureMessages = new Map<string, vscode.TestMessage[]>(); // testItemId → messages

      function itemIdForFile(fileUri: vscode.Uri): string {
        return fileUri.toString();
      }

      function itemIdForTest(fileUri: vscode.Uri, title: string): string {
        return `${fileUri.toString()}::${title}`;
      }

      function ensureFileItem(fileUri: vscode.Uri): vscode.TestItem {
        const id = itemIdForFile(fileUri);
        let item = items.get(id);
        if (!item) {
          item = controller.createTestItem(id, path.basename(fileUri.fsPath), fileUri);
          controller.items.add(item);
          items.set(id, item);
        }
        return item;
      }

      function ensureTestItem(fileUri: vscode.Uri, title: string, line?: number): vscode.TestItem {
        const id = itemIdForTest(fileUri, title);
        let item = items.get(id);
        if (!item) {
          const fileItem = ensureFileItem(fileUri);
          item = controller.createTestItem(id, title, fileUri);
          if (line != null && line >= 1) {
            item.range = new vscode.Range(line - 1, 0, line - 1, 0);
          }
          fileItem.children.add(item);
          items.set(id, item);
        }
        return item;
      }

      return {
        recordPause: (pause): void => {
          const fileUri = vscode.Uri.file(pause.file);
          const item = ensureTestItem(fileUri, pause.test_title, pause.line);

          const md = new vscode.MarkdownString(
            `**${pause.test_title}** failed at \`${path.basename(pause.file)}:${pause.line ?? '?'}\`.\n\n` +
              `${pause.failing_assertion}\n\n` +
              `_Browser held at \`${pause.cdp_ws_url}\` — ask Copilot to investigate._`,
          );
          // Menu route (testing/message/content) carries the command actions —
          // MarkdownString.isTrusted stays off because we do not use
          // `command:` URI links anywhere in S4. If a future slice adds them,
          // set isTrusted with an explicit `enabledCommands` allowlist.
          md.isTrusted = false;
          const msg = new vscode.TestMessage(md);
          msg.contextValue = 'qaDebugPaused';
          if (pause.line != null && pause.line >= 1) {
            msg.location = new vscode.Location(fileUri, new vscode.Position(pause.line - 1, 0));
          }
          msg.stackTrace = pause.stack_trace.frames.slice(0, 20).map(parseStackFrame);

          // Track for potential sticky-retention on marked-passed transition.
          const msgs = failureMessages.get(item.id) ?? [];
          msgs.push(msg);
          failureMessages.set(item.id, msgs);

          run.started(item);
          run.failed(item, msgs);
        },

        recordDecision: (decision, pause): void => {
          // The session_id-keyed pause may not be reachable here; fall back to
          // looking up via title if needed. Best-effort.
          const fileUri = pause ? vscode.Uri.file(pause.file) : undefined;
          const title = decision.test_title.replace(/^.*? > /, ''); // strip suite-path prefix
          const item =
            (fileUri && items.get(itemIdForTest(fileUri, title))) ||
            // Fallback: scan map for matching title
            Array.from(items.values()).find((it) => it.label === title);

          if (!item) {
            appendInfo(channel, `[test-controller] no TestItem for "${decision.test_title}"`);
            return;
          }

          const durationMs = pause ? Date.now() - pause.paused_at_ms : 0;
          const reasonOrRationale = decision.reason;
          appendDecision(channel, {
            sessionId: decision.session_id,
            testTitle: decision.test_title,
            decision: decision.kind,
            by: decision.by,
            reasonOrRationale,
          });

          switch (decision.kind) {
            case 'mark_passed': {
              // §7.2 [R#2-B1] mapping: keep the failure TestMessage attached for
              // visual distinction, set description, transition to passed.
              item.description = '(marked passed)';
              const msgs = failureMessages.get(item.id) ?? [];
              const stickyMd = new vscode.MarkdownString(
                `## Marked passed by ${decision.by}\n\n${reasonOrRationale}\n\n` +
                  `_Original failure shown below for the audit trail._`,
              );
              stickyMd.isTrusted = false;
              const stickyMsg = new vscode.TestMessage(stickyMd);
              stickyMsg.contextValue = 'qaDebugMarkedPassed';
              msgs.unshift(stickyMsg);
              // Re-emit the failure messages BEFORE the passed transition so the
              // results panel keeps them attached. (Pre-S4-PR smoke verifies
              // retention per §7.2 R#3-NB1.)
              run.failed(item, msgs);
              run.passed(item, durationMs);
              run.appendOutput(
                `✓ marked-passed by ${decision.by}: ${reasonOrRationale}\r\n`,
                undefined,
                item,
              );
              break;
            }
            case 'give_up': {
              run.appendOutput(
                `✗ give-up by ${decision.by}: ${reasonOrRationale}\r\n`,
                undefined,
                item,
              );
              // TestItem stays in `failed` state from the prior recordPause.
              break;
            }
            case 'retry': {
              run.appendOutput(
                `↻ retry by ${decision.by}: ${reasonOrRationale}\r\n`,
                undefined,
                item,
              );
              // TestItem stays as queued; next pause-publish from the respawn
              // re-uses the same item per the id formula (§7.3 NB#10).
              run.started(item);
              break;
            }
          }
        },

        end: (): void => {
          run.end();
        },
      };
    },
  };
}

const FRAME_RE = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;

function parseStackFrame(line: string): vscode.TestMessageStackFrame {
  const m = FRAME_RE.exec(line);
  if (!m) return new vscode.TestMessageStackFrame(line);
  const [, label, filePath, lineStr, colStr] = m;
  return new vscode.TestMessageStackFrame(
    label,
    vscode.Uri.file(filePath),
    new vscode.Position(Number(lineStr) - 1, Number(colStr) - 1),
  );
}
