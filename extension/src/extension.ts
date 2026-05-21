/**
 * QA Debug Companion — activate() orchestration.
 *
 * S4_DESIGN.md §2 module map + §11 stale-resume.
 */

import * as vscode from 'vscode';
import path from 'node:path';

import { ChromeProcess } from './chrome.js';
import { registerCommands } from './commands.js';
import { DecisionRouter } from './decision-router.js';
import { QaDebugMcpProvider } from './mcp-provider.js';
import { appendInfo, createAuditChannel } from './output-channel.js';
import { MementoPauseStore } from './pause-store.js';
import { hostQaDebugMcp, type QaDebugMcpHost } from './qa-debug-server.js';
import { SessionManager } from './session-manager.js';
import { smokeTestMessageRetention } from './smoke-test-message.js';
import { createTestControllerWrapper } from './test-controller.js';

let qaDebugHost: QaDebugMcpHost | undefined;
let sessionManagerSingleton: SessionManager | undefined;

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
  qaDebugHost = await hostQaDebugMcp(pauseStore, channel);
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
  // wrapper, so use a deferred binding.
  let sessionMgr: SessionManager | undefined;
  const testControllerWrapper = createTestControllerWrapper(context, channel, async () => {
    if (!sessionMgr) {
      void vscode.window.showErrorMessage('QA Debug: session manager not ready.');
      return;
    }
    await sessionMgr.runFixtureSuite();
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
    });
    sessionManagerSingleton = sessionMgr;
    registerCommands(context, {
      pauseStore,
      decisionRouter,
      sessionManager: sessionMgr,
      channel,
    });
    // Stale-resume per §11 — surface the persisted pause with reduced action surface.
    await sessionMgr.resumeStalePauseIfAny();
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
