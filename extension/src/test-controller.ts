/**
 * TestController integration — renders pauses and decisions in Test Explorer
 * per S4_DESIGN §7, extended for ARCHITECTURE-CR-v5.5 (test discovery +
 * selective run).
 *
 * Tri-state mapping (S4 §7.2 [R#2-B1]):
 *   passed         → run.passed
 *   failed         → run.failed (already in that state from pause-publish)
 *   marked-passed  → keep the failed TestMessage attached + set description
 *                    '(marked passed)' + transition run.passed + appendOutput
 *                    rationale row.
 *
 * v5.5 — TestItem id formula (CR §2.3 / §3.8):
 *   File     = `${fileUri.toString()}`
 *   Describe = `${fileUri}::describe::${describePath.join('>')}`
 *   It       = `${fileUri}::it::${fullTitle}` (matches Mocha Runnable.fullTitle())
 *
 * Discovery + pause unification (C1): pause.publish carries `full_title` so
 * `lookupOrCreateTestItem(uri, full_title)` lands on the same id the AST
 * discovery created — no fork.
 */

import * as vscode from 'vscode';
import path from 'node:path';

import type { PausePayload } from '@qa-debug/pause-store-types';
import type { FinalDecisionParams } from '@qa-debug/mocha-hooks/protocol';

import { appendDecision, appendInfo } from './output-channel.js';
import {
  parseSpec,
  type DiscoveredDescribe,
  type DiscoveredFile,
  type DiscoveredTest,
} from './test-discovery.js';

export interface TestRunHandle {
  /** Lazy-create or look up the TestItem for a paused test; mark it failed with the inline buttons. */
  recordPause(pause: PausePayload): void;
  /** Apply tri-state outcome from a final_decision notification. */
  recordDecision(decision: FinalDecisionParams, pause: PausePayload | undefined): void;
  /**
   * v5.13 — close the loop when a retry respawn passes: mark the TestItem green,
   * clear the pause-time busy spinner + description. Invoked from session-manager
   * when the child's `test.passed` request matches the active pause's full_title.
   * See PLAN-retry-pass-recovery.md.
   */
  recordRetryPassed(pause: PausePayload): void;
  /**
   * v5.13 — synthesize a give-up-shaped UI transition when mocha crashes after a
   * retry commit (the original decision callback was consumed, so no agent/human
   * can resolve the stranded pause). Mirrors `give_up` but with `by: 'env'`.
   */
  recordCrashCleared(pause: PausePayload): void;
  /** Mocha exited; flush the run. */
  end(): void;
}

export interface StartSuiteRunOptions {
  specs?: readonly vscode.Uri[];
  /** v5.5 §2.5 — anchored alternation grep synthesized from selection. */
  grep?: string;
  /** v5.5 C2 — wired to mocha child via SIGTERM in SessionManager. */
  cancellationToken?: vscode.CancellationToken;
}

export type StartSuiteRunCallback = (opts: StartSuiteRunOptions) => Promise<void> | void;

export interface TestControllerWrapper {
  controller: vscode.TestController;
  /** Begin a new run; returns a handle scoped to this suite invocation. */
  beginRun(name?: string): TestRunHandle;
  /** v5.5 §2.7 — invoked from FileSystemWatcher; re-reads the file and merges the diff. */
  reparseFile(uri: vscode.Uri): Promise<void>;
  /** v5.5 §2.7 — invoked from FileSystemWatcher onCreate. */
  addFileItem(uri: vscode.Uri): void;
  /** v5.5 §2.7 — invoked from FileSystemWatcher onDelete. */
  removeFileItem(uri: vscode.Uri): void;
}

const TAG_SKIP = new vscode.TestTag('qa-debug.skip');
const TAG_ONLY = new vscode.TestTag('qa-debug.only');

// CR-v5.6 §3.5.1 — short summary for TestItem.description (inline next to label).
const PAUSE_SUMMARY_MAX = 80;
function truncatePauseSummary(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > PAUSE_SUMMARY_MAX ? `${oneLine.slice(0, PAUSE_SUMMARY_MAX - 1)}…` : oneLine;
}

function itemIdForFile(fileUri: vscode.Uri): string {
  return fileUri.toString();
}

function itemIdForDescribe(fileUri: vscode.Uri, describePath: readonly string[]): string {
  return `${fileUri.toString()}::describe::${describePath.join('>')}`;
}

function itemIdForTest(fileUri: vscode.Uri, fullTitle: string): string {
  return `${fileUri.toString()}::it::${fullTitle}`;
}

function isFileItem(item: vscode.TestItem): boolean {
  return !item.id.includes('::');
}

function isDescribeItem(item: vscode.TestItem): boolean {
  return item.id.includes('::describe::');
}

function isItItem(item: vscode.TestItem): boolean {
  return item.id.includes('::it::');
}

function fullTitleFromItId(id: string): string {
  const i = id.indexOf('::it::');
  return id.slice(i + '::it::'.length);
}

function describePathFromDescribeId(id: string): readonly string[] {
  const i = id.indexOf('::describe::');
  return id.slice(i + '::describe::'.length).split('>');
}

/** §6.4.1 — escape regex metacharacters per MDN-canonical pattern.
 *  Shared with SessionManager (NB4 — single source of truth). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createTestControllerWrapper(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  startSuiteRun: StartSuiteRunCallback,
): TestControllerWrapper {
  const controller = vscode.tests.createTestController('qa-debug-tests', 'QA Debug Companion');
  context.subscriptions.push(controller);

  // v5.5 — items live for the controller's lifetime so discovery + run + pause
  // events all reference the same TestItem instances.
  const items = new Map<string, vscode.TestItem>();
  // Parallel record of the last-parsed DiscoveredFile per file URI; used by
  // planRun for .only warnings and by reparse-merge for diff bookkeeping.
  const discoveredFiles = new Map<string, DiscoveredFile>();
  // it-id → DiscoveredTest, so planRun can check `computedTitle` /
  // `only_filter_will_skip` without re-parsing.
  const discoveredByItId = new Map<string, DiscoveredTest>();

  function ensureFileItem(fileUri: vscode.Uri): vscode.TestItem {
    const id = itemIdForFile(fileUri);
    let item = items.get(id);
    if (!item) {
      item = controller.createTestItem(id, path.basename(fileUri.fsPath), fileUri);
      item.canResolveChildren = true;
      controller.items.add(item);
      items.set(id, item);
    }
    return item;
  }

  function lookupOrCreateTestItem(
    fileUri: vscode.Uri,
    fullTitle: string,
    line?: number,
  ): vscode.TestItem {
    const id = itemIdForTest(fileUri, fullTitle);
    let item = items.get(id);
    if (item) return item;
    // Race: pause fired before any discovery walk for this file (e.g., user
    // invoked qa-debug.runFixture without ever opening Test Explorer). Create
    // a placeholder; a subsequent resolveHandler merge replaces by-id per
    // vscode.d.ts:18749.
    const fileItem = ensureFileItem(fileUri);
    item = controller.createTestItem(id, fullTitle, fileUri);
    if (line != null && line >= 1) {
      item.range = new vscode.Range(line - 1, 0, line - 1, 0);
    }
    fileItem.children.add(item);
    items.set(id, item);
    return item;
  }

  controller.resolveHandler = async (item): Promise<void> => {
    if (item === undefined) {
      await populateRoot();
      return;
    }
    if (isFileItem(item)) {
      await parseAndPopulate(item);
    }
  };

  async function populateRoot(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*.spec.{ts,js}', '**/node_modules/**');
    let added = 0;
    for (const uri of uris) {
      const id = itemIdForFile(uri);
      if (items.has(id)) continue;
      const item = controller.createTestItem(id, path.basename(uri.fsPath), uri);
      item.canResolveChildren = true;
      controller.items.add(item);
      items.set(id, item);
      added++;
    }
    if (added === 0) {
      appendInfo(channel, `[test-discovery] root populate (re-entry) — ${uris.length} file items unchanged`);
    } else {
      appendInfo(channel, `[test-discovery] root populate added=${added} total-files=${uris.length}`);
    }
  }

  async function parseAndPopulate(fileItem: vscode.TestItem): Promise<void> {
    if (!fileItem.uri) return;
    const uri = fileItem.uri;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const discovered = parseSpec(uri, text);
      discoveredFiles.set(uri.toString(), discovered);
      mergeDiscovered(fileItem, discovered);
      if (discovered.parseError) {
        fileItem.description = `(parse error: ${discovered.parseError.slice(0, 80)})`;
      } else {
        fileItem.description = undefined;
      }
      appendInfo(
        channel,
        `[test-discovery] parsed file=${uri.toString()} children=${discovered.children.length}` +
          (discovered.parseError ? ' parseError=true' : ''),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendInfo(channel, `[test-discovery] parse failed file=${uri.toString()}: ${msg}`);
      fileItem.description = `(read error: ${msg.slice(0, 80)})`;
    }
  }

  function mergeDiscovered(fileItem: vscode.TestItem, discovered: DiscoveredFile): void {
    const seen = new Set<string>();
    seen.add(fileItem.id);
    addNodes(fileItem, discovered.uri, discovered.children, seen);
    // Drop items under this file that the new parse no longer contains
    // (NB10 id-based replace — preserves expand/collapse state for surviving items).
    const filePrefix = `${discovered.uri.toString()}::`;
    for (const id of Array.from(items.keys())) {
      if (!id.startsWith(filePrefix)) continue;
      if (seen.has(id)) continue;
      const stale = items.get(id);
      stale?.parent?.children.delete(id);
      items.delete(id);
      discoveredByItId.delete(id);
    }
  }

  function addNodes(
    parent: vscode.TestItem,
    fileUri: vscode.Uri,
    nodes: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>,
    seen: Set<string>,
  ): void {
    for (const node of nodes) {
      if (node.kind === 'describe') {
        const id = itemIdForDescribe(fileUri, [...node.describePath, node.title]);
        seen.add(id);
        let item = items.get(id);
        if (!item) {
          item = controller.createTestItem(id, node.title, fileUri);
          item.canResolveChildren = true;
          items.set(id, item);
        }
        applyAttributes(item, node);
        parent.children.add(item);
        addNodes(item, fileUri, node.children, seen);
      } else {
        const id = itemIdForTest(fileUri, node.fullTitle);
        seen.add(id);
        let item = items.get(id);
        if (!item) {
          item = controller.createTestItem(id, node.title, fileUri);
          items.set(id, item);
        } else {
          item.label = node.title;
        }
        applyAttributes(item, node);
        parent.children.add(item);
        discoveredByItId.set(id, node);
      }
    }
  }

  function applyAttributes(
    item: vscode.TestItem,
    node: DiscoveredDescribe | DiscoveredTest,
  ): void {
    const tags: vscode.TestTag[] = [];
    if (node.skip) tags.push(TAG_SKIP);
    if (node.only) tags.push(TAG_ONLY);
    item.tags = tags;
    item.range = new vscode.Range(node.line - 1, 0, node.line - 1, 0);

    const descParts: string[] = [];
    if (node.skip) descParts.push('(skip)');
    if (node.only) descParts.push('(only)');
    if (node.computedTitle) descParts.push('(computed title)');
    if (node.reservedSeparator) descParts.push('(reserved separator)');
    item.description = descParts.length > 0 ? descParts.join(' ') : undefined;

    if (node.reservedSeparator) {
      appendInfo(
        channel,
        `[test-discovery] title contains reserved separator; rendering with description=(reserved separator) id=${item.id}`,
      );
    }
  }

  // ---------------- Run profile ----------------

  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      try {
        const plan = planRun(request);
        for (const w of plan.onlySkipWarnings) {
          appendInfo(channel, w);
        }
        appendInfo(
          channel,
          `[test-controller] run plan specs=${plan.specs?.length ?? 0} ` +
            `grep=${plan.grep ? JSON.stringify(plan.grep) : '<none>'}`,
        );
        await startSuiteRun({
          specs: plan.specs,
          grep: plan.grep,
          cancellationToken: token,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendInfo(channel, `[test-controller] suite run failed: ${msg}`);
      }
    },
    /* isDefault */ true,
  );

  interface FileSelection {
    fileUri: vscode.Uri;
    runEntireFile: boolean;
    concreteFullTitles: Set<string>;
    /** Describe paths whose subtree is partial (computed titles inside) — use prefix fallback. */
    prefixDescribePaths: Set<string>;
  }

  function planRun(request: vscode.TestRunRequest): {
    specs?: readonly vscode.Uri[];
    grep?: string;
    onlySkipWarnings: string[];
  } {
    if (!request.include || request.include.length === 0) {
      // vscode.d.ts:18604 — undefined include means "run all".
      return { onlySkipWarnings: [] };
    }
    const excludeIds = new Set((request.exclude ?? []).map((it) => it.id));
    const byFile = new Map<string, FileSelection>();

    function getSel(fileUri: vscode.Uri): FileSelection {
      const k = fileUri.toString();
      let s = byFile.get(k);
      if (!s) {
        s = {
          fileUri,
          runEntireFile: false,
          concreteFullTitles: new Set(),
          prefixDescribePaths: new Set(),
        };
        byFile.set(k, s);
      }
      return s;
    }

    function collectLeavesInItem(item: vscode.TestItem): {
      leaves: string[];
      hasComputed: boolean;
    } {
      const leaves: string[] = [];
      let hasComputed = false;
      function walk(it: vscode.TestItem): void {
        if (excludeIds.has(it.id)) return;
        it.children.forEach((child) => {
          if (excludeIds.has(child.id)) return;
          if (isItItem(child)) {
            const discovered = discoveredByItId.get(child.id);
            if (discovered?.computedTitle) {
              hasComputed = true;
            } else {
              leaves.push(fullTitleFromItId(child.id));
            }
          } else if (isDescribeItem(child)) {
            walk(child);
          }
        });
      }
      walk(item);
      return { leaves, hasComputed };
    }

    for (const item of request.include) {
      if (excludeIds.has(item.id)) continue;
      if (!item.uri) continue;
      const sel = getSel(item.uri);
      if (isFileItem(item)) {
        sel.runEntireFile = true;
      } else if (isItItem(item)) {
        const discovered = discoveredByItId.get(item.id);
        if (discovered?.computedTitle) {
          // Single computed-title it has no static name; fall back to running
          // its parent describe (best Phase 1 approximation).
          const describePath = discovered.describePath.join(' ');
          if (describePath.length > 0) sel.prefixDescribePaths.add(describePath);
          else sel.runEntireFile = true;
        } else {
          sel.concreteFullTitles.add(fullTitleFromItId(item.id));
        }
      } else if (isDescribeItem(item)) {
        const { leaves, hasComputed } = collectLeavesInItem(item);
        if (hasComputed || leaves.length === 0) {
          const fullDescribePath = describePathFromDescribeId(item.id).join(' ');
          sel.prefixDescribePaths.add(fullDescribePath);
        } else {
          for (const t of leaves) sel.concreteFullTitles.add(t);
        }
      }
    }

    // .only warning per NB6
    const onlySkipWarnings: string[] = [];
    for (const sel of byFile.values()) {
      const discovered = discoveredFiles.get(sel.fileUri.toString());
      if (!discovered) continue;
      // Does the file contain any .only?
      let fileHasOnly = false;
      function checkOnly(nodes: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>): void {
        if (fileHasOnly) return;
        for (const n of nodes) {
          if (n.only) {
            fileHasOnly = true;
            return;
          }
          if (n.kind === 'describe') checkOnly(n.children);
        }
      }
      checkOnly(discovered.children);
      if (!fileHasOnly) continue;
      // Are any selected leaves outside the .only subtrees?
      const skippedTitles: string[] = [];
      const collect = sel.runEntireFile
        ? /* all leaves */ collectAllLeaves(discovered.children)
        : Array.from(sel.concreteFullTitles).map((ft) => discoveredByItId.get(
            itemIdForTest(sel.fileUri, ft),
          ))
            .filter((d): d is DiscoveredTest => !!d);
      for (const leaf of collect) {
        if (leaf.only_filter_will_skip) {
          skippedTitles.push(leaf.fullTitle);
        }
      }
      if (skippedTitles.length > 0) {
        onlySkipWarnings.push(
          `[test-controller] selection contains ${skippedTitles.length} test(s) Mocha will skip due to .only filter in ${sel.fileUri.fsPath}`,
        );
      }
    }

    // Synthesize grep — NB13 mandatory alternation parens.
    const altParts: string[] = [];
    for (const sel of byFile.values()) {
      if (sel.runEntireFile) continue;
      for (const ft of sel.concreteFullTitles) {
        altParts.push(escapeRegex(ft));
      }
      for (const prefix of sel.prefixDescribePaths) {
        altParts.push(`${escapeRegex(prefix)} .*`);
      }
    }
    const grep = altParts.length > 0 ? `^(${altParts.join('|')})$` : undefined;
    const specs = Array.from(byFile.values()).map((s) => s.fileUri);

    return { specs, grep, onlySkipWarnings };
  }

  function collectAllLeaves(
    nodes: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>,
  ): DiscoveredTest[] {
    const out: DiscoveredTest[] = [];
    for (const n of nodes) {
      if (n.kind === 'it') out.push(n);
      else out.push(...collectAllLeaves(n.children));
    }
    return out;
  }

  // ---------------- FileSystemWatcher hooks ----------------

  function addFileItem(uri: vscode.Uri): void {
    if (items.has(itemIdForFile(uri))) return;
    ensureFileItem(uri);
    appendInfo(channel, `[test-discovery] file added uri=${uri.toString()}`);
  }

  function removeFileItem(uri: vscode.Uri): void {
    const id = itemIdForFile(uri);
    const item = items.get(id);
    if (!item) return;
    controller.items.delete(id);
    items.delete(id);
    discoveredFiles.delete(uri.toString());
    const filePrefix = `${uri.toString()}::`;
    for (const childId of Array.from(items.keys())) {
      if (!childId.startsWith(filePrefix)) continue;
      items.delete(childId);
      discoveredByItId.delete(childId);
    }
    appendInfo(channel, `[test-discovery] file removed uri=${uri.toString()}`);
  }

  async function reparseFile(uri: vscode.Uri): Promise<void> {
    const id = itemIdForFile(uri);
    const fileItem = items.get(id);
    if (!fileItem) {
      // Re-add — onChange fired for a file the user just renamed in
      addFileItem(uri);
      return;
    }
    await parseAndPopulate(fileItem);
  }

  return {
    controller,
    addFileItem,
    removeFileItem,
    reparseFile,
    beginRun: (name?: string): TestRunHandle => {
      const request = new vscode.TestRunRequest();
      // v5.11 — close + reopen resets the run state per PLAN-no-persist-on-restart.md.
      // VS Code testing-guide on the persist flag: "Passing `false` here instructs
      // VS Code not to retain the test result, like it would for runs in the editor,
      // since these results can be reloaded from an external source externally."
      const run = controller.createTestRun(request, name, /* persist */ false);
      const failureMessages = new Map<string, vscode.TestMessage[]>(); // testItemId → messages

      return {
        recordPause: (pause): void => {
          const fileUri = vscode.Uri.file(pause.file);
          // v5.5 C1 — unified id via full_title; matches discovery formula.
          const item = lookupOrCreateTestItem(fileUri, pause.full_title, pause.line);
          if (item.label !== pause.test_title && item.label !== pause.full_title) {
            // Discovery has already populated the it.title; don't overwrite.
          }
          appendInfo(channel, `[test-controller] paused on id=${item.id}`);

          const md = new vscode.MarkdownString(
            `**${pause.test_title}** failed at \`${path.basename(pause.file)}:${pause.line ?? '?'}\`.\n\n` +
              `${pause.failing_assertion}\n\n` +
              `_Browser held at \`${pause.cdp_ws_url}\` — ask Copilot to investigate._`,
          );
          md.isTrusted = false;
          const msg = new vscode.TestMessage(md);
          msg.contextValue = 'qaDebugPaused';
          if (pause.line != null && pause.line >= 1) {
            msg.location = new vscode.Location(fileUri, new vscode.Position(pause.line - 1, 0));
          }
          msg.stackTrace = pause.stack_trace.frames.slice(0, 20).map(parseStackFrame);

          const msgs = failureMessages.get(item.id) ?? [];
          msgs.push(msg);
          failureMessages.set(item.id, msgs);

          // CR-v5.6 §3.5.1 (R6#A) — keep the item in `started` state during
          // pause; surface pause cue via description + busy. Defer
          // `run.failed()` until decision commit (give_up or mark_passed) so
          // Copilot Chat's ✨ inline-icon (gated on testResultState == failed
          // per copilot/package.json) does NOT render alongside our four
          // inline icons (contributed via testing/item/context, gated on
          // testId in qa-debug.pausedTestIds). The TestMessage[] is
          // accumulated in `failureMessages` for attachment at decision time.
          run.started(item);
          item.description = `⏸ paused — ${truncatePauseSummary(pause.failing_assertion)}`;
          item.busy = true;

          // Mirror stack to terminal panel so the QA still has the full trace
          // at hand (the inline-peek hover that previously surfaced via the
          // attached TestMessage is deferred until give-up commit).
          run.appendOutput(
            `⏸️ paused at ${pause.file}:${pause.line ?? '?'}\r\n${pause.failing_assertion}\r\n`,
            undefined,
            item,
          );
        },

        recordDecision: (decision, pause): void => {
          // v5.5 §2.4 / NB8 — unified id lookup; the buggy `.replace(/^.*? > /, '')`
          // strip is gone (Mocha joins ancestors with single space, never ` > `).
          const fileUri = pause ? vscode.Uri.file(pause.file) : undefined;
          const fullTitle = decision.full_title;
          const item =
            (fileUri && items.get(itemIdForTest(fileUri, fullTitle))) ||
            Array.from(items.values()).find((it) => it.id.endsWith(`::it::${fullTitle}`));

          if (!item) {
            appendInfo(channel, `[test-controller] no TestItem for "${decision.full_title}"`);
            return;
          }

          const durationMs = pause ? Date.now() - pause.paused_at_ms : 0;
          const reasonOrRationale = decision.reason;
          appendDecision(channel, {
            sessionId: decision.session_id,
            testTitle: decision.full_title,
            decision: decision.kind,
            by: decision.by,
            reasonOrRationale,
          });

          switch (decision.kind) {
            case 'mark_passed': {
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
              run.failed(item, msgs);
              run.passed(item, durationMs);
              run.appendOutput(
                `✓ marked-passed by ${decision.by}: ${reasonOrRationale}\r\n`,
                undefined,
                item,
              );
              // CR-v5.6 §3.5.1 — clear pause-time busy. F-v5.6-b verifies
              // the failed→passed transition produces no perceptible flash
              // > 1 frame at 60Hz; if observed, re-sequence per I2#D.
              item.busy = false;
              break;
            }
            case 'give_up': {
              // CR-v5.6 §3.5.1 (R6#A) — first-and-only `run.failed()` call
              // in this path; pause-publish no longer reports failed. ✨
              // appears here in its correct bibliographic context.
              const giveUpMsgs = failureMessages.get(item.id) ?? [];
              run.failed(item, giveUpMsgs);
              run.appendOutput(
                `✗ give-up by ${decision.by}: ${reasonOrRationale}\r\n`,
                undefined,
                item,
              );
              item.description = undefined;
              item.busy = false;
              break;
            }
            case 'retry': {
              run.appendOutput(
                `↻ retry by ${decision.by}: ${reasonOrRationale}\r\n`,
                undefined,
                item,
              );
              // CR-v5.6 §3.5.1 — item never left `started` state under the
              // new model; no revival call needed. Clear description; keep
              // busy true (mocha will respawn and either re-pause or pass).
              // v5.13: the "pass" half of this bargain is now wired via
              // recordRetryPassed below; the "re-pause" half re-enters
              // recordPause naturally on the respawn's pause.publish.
              item.description = undefined;
              break;
            }
          }
        },

        recordRetryPassed: (pause): void => {
          const fileUri = vscode.Uri.file(pause.file);
          const item =
            items.get(itemIdForTest(fileUri, pause.full_title)) ||
            Array.from(items.values()).find((it) => it.id.endsWith(`::it::${pause.full_title}`));
          if (!item) {
            appendInfo(channel, `[test-controller] no TestItem for retry-pass "${pause.full_title}"`);
            return;
          }
          const durationMs = Date.now() - pause.paused_at_ms;
          appendDecision(channel, {
            sessionId: pause.session_id,
            testTitle: pause.full_title,
            decision: 'retry_passed',
            by: 'env',
            reasonOrRationale: `respawn passed after ${durationMs}ms`,
          });
          run.passed(item, durationMs);
          item.busy = false;
          item.description = undefined;
          run.appendOutput(`✓ retry passed after ${durationMs}ms\r\n`, undefined, item);
        },

        recordCrashCleared: (pause): void => {
          const fileUri = vscode.Uri.file(pause.file);
          const item =
            items.get(itemIdForTest(fileUri, pause.full_title)) ||
            Array.from(items.values()).find((it) => it.id.endsWith(`::it::${pause.full_title}`));
          if (!item) {
            appendInfo(channel, `[test-controller] no TestItem for crash-cleared "${pause.full_title}"`);
            return;
          }
          const reason = 'mocha crashed during retry respawn';
          appendDecision(channel, {
            sessionId: pause.session_id,
            testTitle: pause.full_title,
            decision: 'crash_cleared',
            by: 'env',
            reasonOrRationale: reason,
          });
          const msgs = failureMessages.get(item.id) ?? [];
          const crashMd = new vscode.MarkdownString(`## Cleared by environment\n\n${reason}`);
          crashMd.isTrusted = false;
          msgs.push(new vscode.TestMessage(crashMd));
          run.failed(item, msgs);
          run.appendOutput(`✗ ${reason}\r\n`, undefined, item);
          item.description = undefined;
          item.busy = false;
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
