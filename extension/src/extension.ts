/**
 * QA Debug Companion — activate() orchestration.
 *
 * S4_DESIGN.md §2 module map + §11 stale-resume.
 */

import * as vscode from 'vscode';
import path from 'node:path';

import { appendDeactivateAudit } from './audit-file.js';
import { registerQaDebugChatParticipant } from './chat-participant.js';
import { ChromeProcess } from './chrome.js';
import { registerCommands } from './commands.js';
import { DecisionRouter } from './decision-router.js';
import { QaDebugMcpProvider } from './mcp-provider.js';
import { appendInfo, createAuditChannel } from './output-channel.js';
import { registerPauseStatusBar } from './pause-status-bar.js';
import { MementoPauseStore } from './pause-store.js';
import { hostQaDebugMcp, type QaDebugMcpHost } from './qa-debug-server.js';
import { SessionManager } from './session-manager.js';
import { smokeTestMessageRetention } from './smoke-test-message.js';
import { createTestControllerWrapper } from './test-controller.js';

let qaDebugHost: QaDebugMcpHost | undefined;
let sessionManagerSingleton: SessionManager | undefined;
// v5.7 — closure captures pauseStore + decisionRouter + context.globalState +
// context.globalStorageUri at activate() so deactivate() can synthesize give_up
// + append audit-file line + write the clean-shutdown sentinel. Avoids adding
// 4 module-level singletons per PLAN-clean-shutdown-sentinel.md [R#NB4].
let deactivateHook: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = createAuditChannel(context);
  appendInfo(
    channel,
    `[activate] qa-debug-companion ${context.extension.packageJSON.version}`,
  );

  const workspaceRoot = detectWorkspaceRoot();
  if (!workspaceRoot) {
    appendInfo(
      channel,
      `[activate] no workspace folder open — qa-debug commands will error until a folder is opened`,
    );
  }

  const pauseStore = new MementoPauseStore(context.globalState);
  const decisionRouter = new DecisionRouter(channel);
  const chrome = new ChromeProcess(channel);

  // Host the qa-debug MCP server in-extension over Streamable HTTP. The
  // McpProvider returns its URI + token as part of the qa-debug definition
  // during paused state.
  qaDebugHost = await hostQaDebugMcp(pauseStore, decisionRouter, channel);
  context.subscriptions.push({
    dispose: () => {
      void qaDebugHost?.dispose();
    },
  });

  const mcpProvider = new QaDebugMcpProvider(qaDebugHost.uri, qaDebugHost.token);
  context.subscriptions.push(mcpProvider);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('qa-debug.mcp-servers', mcpProvider),
  );

  // TestController needs a startSuiteRun callback that delegates to
  // SessionManager. SessionManager isn't constructed until after the
  // wrapper, so use a deferred binding. v5.5 §2.5 — opts gain grep +
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
      grep: opts.grep,
      cancellationToken: opts.cancellationToken,
    });
  });

  // v5.3 §2.3 — probe chat-open commands at activation so notification handler
  // can degrade gracefully. Both are internal commands per CR §0 / [R#3-NB2].
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

  // v5.3 §2.1 — register chat participant. Runtime-guarded inside the helper
  // for engines.vscode below the createChatParticipant landing version.
  if (workspaceRoot) {
    registerQaDebugChatParticipant(context, pauseStore, channel);
  }

  // v5.4 §2.2 / §3.7 — ambient pause indicator. Lives across activations;
  // SessionManager toggles show/hide via the returned handle.
  const pauseStatusBar = registerPauseStatusBar(context, pauseStore, channel);

  // v5.5 §2.7 — FileSystemWatcher keeps the discovered Test Explorer tree in
  // sync with on-disk changes. 300ms per-URI debounce absorbs editor save +
  // multi-buffer flush bursts; reparse semantics are id-based replace (NB10)
  // so expand/collapse state survives.
  const specWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.spec.{ts,js}',
    /* ignoreCreate */ false,
    /* ignoreChange */ false,
    /* ignoreDelete */ false,
  );
  context.subscriptions.push(specWatcher);
  const REPARSE_DEBOUNCE_MS = 300;
  const pendingReparse = new Map<string, NodeJS.Timeout>();
  context.subscriptions.push({
    dispose: () => {
      for (const t of pendingReparse.values()) clearTimeout(t);
      pendingReparse.clear();
    },
  });
  specWatcher.onDidCreate((uri) => {
    testControllerWrapper.addFileItem(uri);
  });
  specWatcher.onDidChange((uri) => {
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
  specWatcher.onDidDelete((uri) => {
    const key = uri.toString();
    const pending = pendingReparse.get(key);
    if (pending) {
      clearTimeout(pending);
      pendingReparse.delete(key);
    }
    testControllerWrapper.removeFileItem(uri);
  });

  if (workspaceRoot) {
    sessionMgr = new SessionManager({
      pauseStore,
      decisionRouter,
      chrome,
      mcpProvider,
      testControllerWrapper,
      channel,
      workspaceRoot,
      chatOpenAvailable,
      chatOpenFallbackAvailable,
      pauseStatusBar,
    });
    sessionManagerSingleton = sessionMgr;
    registerCommands(context, {
      pauseStore,
      decisionRouter,
      sessionManager: sessionMgr,
      channel,
    });

    // v5.7 — wire the clean-shutdown sentinel BEFORE stale-resume. If the
    // sentinel is present, the prior deactivate ran cleanly; suppress the
    // stale-resume UI per PLAN-clean-shutdown-sentinel.md. Crash path (no
    // deactivate ran → no sentinel) falls through to the existing UI.
    const cleanShutdown =
      context.globalState.get<boolean>('qa-debug.clean_shutdown') === true;
    await context.globalState.update('qa-debug.clean_shutdown', undefined);
    if (cleanShutdown) {
      // Defense-in-depth: any orphaned pause data from pre-v5.7 globalState
      // (where no sentinel was written) is stale-by-definition. Remove in v5.8
      // once the migration window passes. [R#NB5]
      await pauseStore.clearActivePause();
      appendInfo(channel, `[activate] clean-shutdown sentinel found; skipped stale-resume`);
    } else {
      // Stale-resume per S4_DESIGN §11 — surface the persisted pause with
      // reduced action surface (Give Up only). v5.7 amendment: only fires when
      // the prior shutdown did NOT write the clean-shutdown sentinel.
      await sessionMgr.resumeStalePauseIfAny();
    }

    // v5.7 — capture closure for deactivate(). Fires after sessionMgr is wired
    // so abandon() can route to its enrolled callback if mocha is still alive.
    deactivateHook = async (): Promise<void> => {
      const active = pauseStore.peekActivePause();
      if (active) {
        // Best-effort: synthesize give_up via DecisionRouter. abandon() never
        // throws — returns false + logs if no pending callback exists.
        decisionRouter.abandon(active.session_id, 'extension deactivated', 'hook');
        try {
          await appendDeactivateAudit(context.globalStorageUri, active);
        } catch (err) {
          // Audit-completeness degrades gracefully; never block shutdown.
          const msg = err instanceof Error ? err.message : String(err);
          appendInfo(channel, `[deactivate] audit-file append failed: ${msg}`);
        }
        await pauseStore.clearActivePause();
      }
      // Boolean sentinel — proves "the close immediately preceding the next
      // activate was clean." No freshness window per [R#NB3].
      await context.globalState.update('qa-debug.clean_shutdown', true);
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

  // Pre-S4-PR TestMessage-retention smoke per S4_DESIGN §7.2 R#3-NB1.
  // Invoked via Command Palette: "QA Debug: Smoke — TestMessage Retention".
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qa-debug.smokeTestMessageRetention',
      () => smokeTestMessageRetention(),
    ),
  );

  appendInfo(channel, `[activate] ready (qa-debug MCP host at ${qaDebugHost.uri.toString()})`);
}

export async function deactivate(): Promise<void> {
  // v5.7 — sentinel + audit-file flow runs first; sessionMgr/host dispose
  // chain follows. Audit write is best-effort and bounded under the ~5s VS
  // Code deactivate budget (extHostExtensionService Promise.race(timeout(5000))).
  await deactivateHook?.();
  await sessionManagerSingleton?.dispose();
  await qaDebugHost?.dispose();
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
