/**
 * QA Debug Companion — activate() orchestration.
 *
 * activate() orchestration — module map and stale-resume.
 */

import * as vscode from 'vscode';
import path from 'node:path';

import { appendDeactivateAudit, appendOrphanPauseAudit } from './audit-file.js';
import { registerQaDebugChatParticipant } from './chat-participant.js';
import { registerCommands } from './commands.js';
import { DecisionRouter } from './decision-router.js';
import { registerQaDebugLmTools } from './lm-tools/index.js';
import { QaDebugMcpProvider } from './mcp-provider.js';
import { appendInfo, createAuditChannel, createMochaChannel } from './output-channel.js';
import { registerPauseStatusBar } from './pause-status-bar.js';
import { MementoPauseStore } from './pause-store.js';
import { registerRunStatusBar } from './run-status-bar.js';
import { SessionManager } from './session-manager.js';
import { smokeTestMessageRetention } from './smoke-test-message.js';
import { createTestControllerWrapper } from './test-controller.js';
import { getTestMatchGlobs, TEST_MATCH_CONFIG_ID } from './test-glob.js';
import { createUpdateChecker, parseRepoSlugFromPackageJson } from './update-checker.js';

let sessionManagerSingleton: SessionManager | undefined;
// Closure captures pauseStore + decisionRouter + context.globalStorageUri at
// activate() so deactivate() can synthesize give_up + append audit-file line.
// Avoids extra module-level singletons.
let deactivateHook: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = createAuditChannel(context);
  const mochaChannel = createMochaChannel(context);
  appendInfo(
    channel,
    `[activate] qa-debug-companion ${context.extension.packageJSON.version}`,
  );

  const updateChecker = createUpdateChecker({
    context,
    channel,
    installedVersion: context.extension.packageJSON.version,
    repoSlug: parseRepoSlugFromPackageJson(context.extension.packageJSON.repository?.url),
  });
  context.subscriptions.push(updateChecker);
  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.checkForUpdates', () => updateChecker.runManualCheck()),
  );
  void updateChecker.runBackgroundCheck();

  // v5.16 — QA_DEBUG_CDP_WS_URL no longer flows to mocha child; per-pause CDP
  // discovery happens in qa-hooks. One-time warning if the user still has it
  // set in their environment.
  if (process.env.QA_DEBUG_CDP_WS_URL) {
    appendInfo(
      channel,
      `[activate] WARN QA_DEBUG_CDP_WS_URL is set but no longer honored — set QA_DEBUG_CDP_PORTS (comma-separated) to override Mode C discovery ports instead`,
    );
  }

  const workspaceRoot = detectWorkspaceRoot();
  if (!workspaceRoot) {
    appendInfo(
      channel,
      `[activate] no workspace folder open — qa-debug commands will error until a folder is opened`,
    );
  }

  const pauseStore = new MementoPauseStore(context.globalState);
  const decisionRouter = new DecisionRouter(channel);

  // qa-debug verbs are now first-party Language Model Tools
  // (extension/src/lm-tools/). The MCP provider survives for playwright-mcp
  // only; it returns [] at idle, [qa-debug-browser(...)] during pause. The
  // server is fronted by the bundled mcp-proxy (rewrites serverInfo.name).
  const mcpProxyPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-proxy.js').fsPath;
  const mcpProvider = new QaDebugMcpProvider(mcpProxyPath);
  context.subscriptions.push(mcpProvider);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('qa-debug.mcp-servers', mcpProvider),
  );

  // Register the qa-debug LanguageModelTool classes (get_failure_context +
  // discover/select chrome; verdict verbs removed 2026-05-31). The per-tool
  // `when: "qa-debug.paused"` clause in package.json gates visibility; these
  // registrations are always live across activations.
  registerQaDebugLmTools(context, {
    pauseStore,
    auditChannel: channel,
  });

  // TestController needs a startSuiteRun callback that delegates to
  // SessionManager. SessionManager isn't constructed until after the
  // wrapper, so use a deferred binding. v5.5 — opts gain grep +
  // cancellationToken so the run handler can pass through the planned
  // alternation grep + the Test Explorer cancel button.
  let sessionMgr: SessionManager | undefined;
  const testControllerWrapper = createTestControllerWrapper(context, channel, async (opts) => {
    if (!sessionMgr) {
      void vscode.window.showErrorMessage('QA Debug: session manager not ready.');
      return;
    }
    await sessionMgr.runFixtureSuite({
      specs: opts.specs,
      runSelection: opts.runSelection,
      cancellationToken: opts.cancellationToken,
    });
  });

  // v5.3 — probe chat-open commands at activation so notification handler
  // can degrade gracefully. Both are internal commands per [R#3-NB2].
  let chatOpenAvailable = false;
  let chatOpenFallbackAvailable = false;
  try {
    const cmds = await vscode.commands.getCommands(true);
    chatOpenAvailable = cmds.includes('workbench.action.chat.open');
    chatOpenFallbackAvailable = cmds.includes('workbench.action.openChat');
  } catch {
    // getCommands rarely fails; treat both as unavailable
  }
  if (!chatOpenAvailable && !chatOpenFallbackAvailable) {
    appendInfo(
      channel,
      `[activate] neither workbench.action.chat.open nor workbench.action.openChat registered; Ask Copilot button will show manual-open instruction`,
    );
  } else if (!chatOpenAvailable) {
    appendInfo(
      channel,
      `[activate] workbench.action.chat.open absent; degraded to workbench.action.openChat (no query seeding)`,
    );
  }

  // v5.3 — register chat participant. Runtime-guarded inside the helper
  // for engines.vscode below the createChatParticipant landing version.
  if (workspaceRoot) {
    registerQaDebugChatParticipant(context, pauseStore, channel);
  }

  // v5.4 — ambient pause indicator. Lives across activations;
  // SessionManager toggles show/hide via the returned handle.
  const pauseStatusBar = registerPauseStatusBar(context, pauseStore, channel);
  const runStatusBar = registerRunStatusBar(context, channel);

  // v5.5 — FileSystemWatcher keeps the discovered Test Explorer tree in
  // sync with on-disk changes. 300ms per-URI debounce absorbs editor save +
  // multi-buffer flush bursts; reparse semantics are id-based replace (NB10)
  // so expand/collapse state survives.
  // v0.0.4 — match the populateRoot glob (test-controller.ts). Watch only the
  // compiled-output spec files mocha will actually run; .ts source edits will
  // re-trigger via the consumer's build watch when build/dist updates.
  // The glob mirrors the `qaDebug.testMatch` setting and is rebuilt when that
  // setting changes so the watched files track the user's chosen dir/suffix.
  const REPARSE_DEBOUNCE_MS = 300;
  const pendingReparse = new Map<string, NodeJS.Timeout>();
  context.subscriptions.push({
    dispose: () => {
      for (const t of pendingReparse.values()) clearTimeout(t);
      pendingReparse.clear();
    },
  });
  // One watcher per testMatch glob (the setting may list several). Rebuilt as a
  // set when the setting changes so watched files track the user's chosen globs.
  let specWatchers: vscode.FileSystemWatcher[] = [];
  const buildSpecWatchers = (): void => {
    for (const w of specWatchers) w.dispose();
    specWatchers = [];
    const globs = getTestMatchGlobs();
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        glob,
        /* ignoreCreate */ false,
        /* ignoreChange */ false,
        /* ignoreDelete */ false,
      );
      watcher.onDidCreate((uri) => {
        testControllerWrapper.addFileItem(uri);
      });
      watcher.onDidChange((uri) => {
        const key = uri.toString();
        const existing = pendingReparse.get(key);
        if (existing) clearTimeout(existing);
        pendingReparse.set(
          key,
          setTimeout(() => {
            pendingReparse.delete(key);
            void testControllerWrapper.reparseFile(uri);
          }, REPARSE_DEBOUNCE_MS),
        );
      });
      watcher.onDidDelete((uri) => {
        const key = uri.toString();
        const pending = pendingReparse.get(key);
        if (pending) {
          clearTimeout(pending);
          pendingReparse.delete(key);
        }
        testControllerWrapper.removeFileItem(uri);
      });
      specWatchers.push(watcher);
    }
    appendInfo(channel, `[test-discovery] watching globs=[${globs.join(', ')}]`);
  };
  buildSpecWatchers();
  context.subscriptions.push({ dispose: () => specWatchers.forEach((w) => w.dispose()) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(TEST_MATCH_CONFIG_ID)) return;
      appendInfo(channel, `[test-discovery] ${TEST_MATCH_CONFIG_ID} changed — rebuilding watchers + tree`);
      buildSpecWatchers();
      void testControllerWrapper.refresh();
    }),
  );

  if (workspaceRoot) {
    sessionMgr = new SessionManager({
      pauseStore,
      decisionRouter,
      mcpProvider,
      testControllerWrapper,
      channel,
      mochaChannel,
      workspaceRoot,
      chatOpenAvailable,
      chatOpenFallbackAvailable,
      pauseStatusBar,
      runStatusBar,
    });
    sessionManagerSingleton = sessionMgr;
    registerCommands(context, {
      pauseStore,
      sessionManager: sessionMgr,
      channel,
    });

    // v5.11 — restart-reset semantics. The previous extension-host instance is
    // gone; any leftover Memento pause is orphaned. Audit-trail goes to
    // audit.jsonl, not live UI.
    const orphan = pauseStore.peekActivePause();
    if (orphan) {
      try {
        await appendOrphanPauseAudit(context.globalStorageUri, orphan);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendInfo(channel, `[activate] orphan-pause audit append failed: ${msg}`);
      }
      appendInfo(
        channel,
        `[activate] orphan pause cleared session=${orphan.session_id} test="${orphan.test_title}"`,
      );
    }
    await pauseStore.clearActivePause();

    deactivateHook = async (): Promise<void> => {
      const active = pauseStore.peekActivePause();
      if (active) {
        decisionRouter.abandon(active.session_id, 'extension deactivated', 'hook');
        try {
          await appendDeactivateAudit(context.globalStorageUri, active);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendInfo(channel, `[deactivate] audit-file append failed: ${msg}`);
        }
        await pauseStore.clearActivePause();
      }
    };
  } else {
    // Register a thin runFixture that complains; the other commands are
    // gated by the qa-debug.paused context key which won't be set without
    // a workspace anyway.
    context.subscriptions.push(
      vscode.commands.registerCommand('qa-debug.runFixture', () => {
        void vscode.window.showErrorMessage(
          'QA Debug: open the project folder before running the fixture suite.',
        );
      }),
    );
  }

  // TestMessage-retention smoke.
  // Invoked via Command Palette: "QA Debug: Smoke — TestMessage Retention".
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qa-debug.smokeTestMessageRetention',
      () => smokeTestMessageRetention(),
    ),
  );

  appendInfo(channel, `[activate] ready (qa-debug LM tools registered; playwright-mcp gate active)`);
}

export async function deactivate(): Promise<void> {
  // audit-file flow runs first; sessionMgr dispose follows. Audit write is
  // best-effort and bounded under the ~5s VS Code deactivate budget
  // (extHostExtensionService Promise.race(timeout(5000))).
  await deactivateHook?.();
  await sessionManagerSingleton?.dispose();
}

function detectWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  // Prefer the folder containing the fixture-tests directory; else first folder.
  for (const f of folders) {
    if (f.uri.scheme === 'file') {
      const candidate = path.join(f.uri.fsPath, 'fixture-tests');
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        if (fs.existsSync(candidate)) return f.uri.fsPath;
      } catch {
        // ignore
      }
    }
  }
  return folders[0].uri.scheme === 'file' ? folders[0].uri.fsPath : undefined;
}
