/**
 * LiveSessionManager — owns the "Live Inspect Session": the extension LAUNCHES
 * the QA's own web/desktop app with a CDP debug port so it can be inspected
 * WITHOUT a paused test. The launch is the trigger (the analog of a test-failure
 * event in the pause flow): on launch we flip the `qa-debug.liveSession` context
 * key and register the app's CDP endpoint as the `qa-debug-cdp` MCP — so it's
 * usable by `browser_*`, `qa_pick_element`, or ANY tool/MCP. The `qa-debug-inspect`
 * custom agent is contributed `when: qa-debug.liveSession` (general inspection,
 * not picker-only) and is selectable from the chat dropdown; the notification's
 * Open Chat opens into it best-effort. We do NOT auto-send a picker prompt.
 *
 * Mirrors SessionManager's browser lifecycle but for a companion-OWNED browser:
 *  - per-launch FREE port allocated from the qaDebug.cdpPorts pool (cross-window
 *    collision guard — two projects never share a port);
 *  - web uses a PER-PROJECT persistent profile (context.storageUri) so logins
 *    persist per project AND multiple project windows each run their own Chrome
 *    (Chrome is single-instance per --user-data-dir; Chrome 136+ also refuses CDP
 *    on the default profile dir);
 *  - the spawned process group is reaped on stop()/deactivate ONLY when we
 *    spawned it (`weSpawned`) — never kill a browser we merely found.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { basename } from 'node:path';
import * as vscode from 'vscode';

import type { AvailableChrome } from '@qa-debug/pause-store-types';

import { CdpBinding } from './cdp-binding.js';
import { sanitizeChildEnv } from './child-env.js';
import { getCdpPorts } from './cdp-ports.js';
import type { InspectionArbiter } from './inspection-arbiter.js';
import type { LiveTargetStore } from './live-target-store.js';
import type { QaDebugMcpProvider } from './mcp-provider.js';
import { appendInfo } from './output-channel.js';
import { probePorts } from './lm-tools/probe-ports.js';
import { signalProcessGroup } from './process-group-kill.js';
import { detectWebBrowserBinary } from './web-browser-path.js';

/** The launch kinds the QA picks from. `web` opens a URL in an auto-detected
 *  browser; `electron`/`openfin` launch a desktop binary — they spawn
 *  identically (binary + --remote-debugging-port) and differ only as a label. */
export type LiveAppType = 'web' | 'electron' | 'openfin';

/** One launchable app — from the inline prompt OR (optional shortcut) a
 *  `qaDebug.liveApps` entry. Only `type` + the url/binary is required; the name
 *  is cosmetic and derived when omitted. */
export interface LiveAppSpec {
  /** Optional friendly name; falls back to the url/binary (see displayName). */
  label?: string;
  type: LiveAppType;
  /** web: the URL to open (required for web). */
  url?: string;
  /** electron/openfin: the app executable (required for desktop kinds). */
  binary?: string;
  /** desktop: extra args passed after the debug-port flag. */
  args?: string[];
  /** Optional fixed port; default = allocate a free one from the pool. */
  port?: number;
}

/** A human-friendly name for a spec — the label if given, else the URL (web) /
 *  binary filename (desktop), else just the type. The app NAME is not required. */
export function liveAppDisplayName(spec: LiveAppSpec): string {
  if (spec.label && spec.label.trim()) return spec.label.trim();
  if (spec.type === 'web') return spec.url ?? 'web app';
  return spec.binary ? basename(spec.binary) : `${spec.type} app`;
}

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 300;

export interface LiveSessionManagerDeps {
  context: vscode.ExtensionContext;
  mcpProvider: QaDebugMcpProvider;
  liveTargetStore: LiveTargetStore;
  arbiter: InspectionArbiter;
  channel: vscode.OutputChannel;
}

interface ActiveLive {
  child?: ChildProcess;
  port: number;
  weSpawned: boolean;
}

export interface LiveSessionStartOptions {
  /** Show the generic Live Inspect notification with Open Chat / Open Audit Log. */
  announce?: boolean;
}

export class LiveSessionManager {
  private active?: ActiveLive;
  /** Endpoint→MCP binding incl. the download-shim hop — shared with SessionManager. */
  private readonly cdpBinding: CdpBinding;
  private readonly statusItem: vscode.StatusBarItem;

  constructor(private readonly deps: LiveSessionManagerDeps) {
    this.cdpBinding = new CdpBinding(deps.mcpProvider, deps.channel, '[live]');
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusItem.command = 'qa-debug.stopInspectApp';
    this.deps.context.subscriptions.push(this.statusItem);
  }

  isActive(): boolean {
    return this.active !== undefined;
  }

  activePort(): number | undefined {
    return this.active?.port;
  }

  /** Launch (or, with a configured fixed port already up, fail clearly) and
   *  establish a Live Inspect Session for `spec`. */
  async launch(spec: LiveAppSpec, opts: LiveSessionStartOptions = {}): Promise<void> {
    const name = liveAppDisplayName(spec);
    if (!this.deps.arbiter.canStart('live')) {
      void vscode.window.showWarningMessage(
        `QA Debug: cannot start inspection — ${this.deps.arbiter.blockingReason()}.`,
      );
      return;
    }

    const port = spec.port ?? (await this.allocatePort());
    if (port === undefined) {
      void vscode.window.showErrorMessage(
        `QA Debug: all debug ports are busy (qaDebug.cdpPorts). Stop another inspect session, ` +
          `or add more ports to qaDebug.cdpPorts.`,
      );
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawnApp(spec, port);
    } catch (err) {
      void vscode.window.showErrorMessage(`QA Debug: launch failed — ${asMessage(err)}`);
      return;
    }
    this.active = { child, port, weSpawned: true };
    // Reserve the mutual-exclusion slot NOW (not after the probe) so a rapid
    // second launch or a concurrent Mocha run can't slip into the ~15s probe
    // window. stop() releases it if the probe fails.
    this.deps.arbiter.setLiveActive(true);
    // If the app process dies on its own, tear the session down.
    child.on('exit', (code, signal) => {
      appendInfo(this.deps.channel, `[live] app exited code=${code} signal=${signal}`);
      if (this.active?.child === child) void this.stop();
    });
    child.on('error', (e) =>
      appendInfo(this.deps.channel, `[live] app spawn error: ${e.message}`),
    );

    appendInfo(
      this.deps.channel,
      `[live] launched "${name}" (${spec.type}) port=${port}; probing for CDP…`,
    );
    this.statusItem.text = `$(sync~spin) Launching… port ${port}`;
    this.statusItem.tooltip = 'Waiting for the app to expose its debug port — click to stop';
    this.statusItem.show();

    const chrome = await this.waitForChrome(port);
    if (!chrome) {
      void vscode.window.showErrorMessage(
        `QA Debug: the launched app did not expose a CDP endpoint on port ${port} within ` +
          `${PROBE_TIMEOUT_MS / 1000}s. Check the app launched and (web) the browser binary.`,
      );
      await this.stop();
      return;
    }

    await this.establishLiveTarget(chrome, port, name, 'launched', opts.announce ?? true);
  }

  /** Attach to an already-running app that exposes a CDP endpoint. This is for
   *  long-lived logged-in browsers/desktops shared across VS Code windows. The
   *  extension only binds MCP; stop() detaches but does not kill the process. */
  async attachExisting(port: number, opts: LiveSessionStartOptions = {}): Promise<boolean> {
    if (!this.deps.arbiter.canStart('live')) {
      void vscode.window.showWarningMessage(
        `QA Debug: cannot attach inspection — ${this.deps.arbiter.blockingReason()}.`,
      );
      return false;
    }

    this.deps.arbiter.setLiveActive(true);
    try {
      appendInfo(this.deps.channel, `[live] probing existing CDP port=${port}`);
      const found = await probePorts([port]);
      const chrome = found[0];
      if (!chrome) {
        void vscode.window.showErrorMessage(
          `QA Debug: no Chrome DevTools endpoint answered on port ${port}. ` +
            `Launch the app with --remote-debugging-port=${port}, or choose launch instead.`,
        );
        await this.stop();
        return false;
      }

      this.active = { port, weSpawned: false };
      await this.establishLiveTarget(
        chrome,
        port,
        `existing CDP port ${port}`,
        'attached',
        opts.announce ?? true,
      );
      return true;
    } catch (err) {
      appendInfo(this.deps.channel, `[live] attach existing port failed: ${asMessage(err)}`);
      await this.stop();
      return false;
    }
  }

  /** Tear down the live session: clear gate, unbind MCP, reap OUR process. */
  async stop(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    this.deps.liveTargetStore.clear();
    this.deps.arbiter.setLiveActive(false);
    this.statusItem.hide();
    await vscode.commands.executeCommand('setContext', 'qa-debug.liveSession', false);
    this.deps.mcpProvider.setIdle();
    await this.cdpBinding.stopShim();

    if (active?.weSpawned && active.child?.pid != null) {
      appendInfo(this.deps.channel, `[live] reaping app process group pid=-${active.child.pid}`);
      signalProcessGroup(active.child.pid, 'SIGINT', (m) => appendInfo(this.deps.channel, m));
      // Best-effort hard follow-up; the SIGINT usually suffices for a browser.
      const pid = active.child.pid;
      setTimeout(() => {
        if (active.child?.exitCode == null) {
          signalProcessGroup(pid, 'SIGKILL', (m) => appendInfo(this.deps.channel, m));
        }
      }, 2_000);
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.statusItem.dispose();
  }

  // ------------------- internal -------------------

  private async establishLiveTarget(
    chrome: AvailableChrome,
    port: number,
    name: string,
    source: 'launched' | 'attached',
    announce: boolean,
  ): Promise<void> {
    const sessionId = `live-${randomUUID()}`;
    this.deps.liveTargetStore.set({
      session_id: sessionId,
      available_chromes: [chrome],
      selected_cdp_port: port,
    });
    await vscode.commands.executeCommand('setContext', 'qa-debug.liveSession', true);
    await this.cdpBinding.bindMcp(chrome.ws_url, ` session=${sessionId} source=${source} port=${port}`);

    this.statusItem.text = `$(inspect) Inspecting port ${port}`;
    this.statusItem.tooltip =
      source === 'attached'
        ? `Live Inspect Session attached to existing CDP port ${port} — click to detach`
        : `Live Inspect Session active on CDP port ${port} — click to stop`;
    this.statusItem.show();
    appendInfo(
      this.deps.channel,
      `[live] session=${sessionId} ready source=${source} name="${name}" port=${port} tabs=${chrome.tab_count} runtime=${chrome.runtime}`,
    );

    if (announce) this.announceSession(port);
  }

  private spawnApp(spec: LiveAppSpec, port: number): ChildProcess {
    const portFlag = `--remote-debugging-port=${port}`;
    let cmd: string;
    let args: string[];
    if (spec.type === 'web') {
      if (!spec.url) throw new Error('web inspection needs a URL.');
      const configured = vscode.workspace
        .getConfiguration('qaDebug')
        .get<string>('webBrowserBinary')
        ?.trim();
      const binary = configured || detectWebBrowserBinary();
      if (!binary) {
        throw new Error(
          'No Chrome/Edge found at a standard location — set qaDebug.webBrowserBinary to your ' +
            'browser executable path.',
        );
      }
      if (!configured) {
        appendInfo(this.deps.channel, `[live] auto-detected web browser: ${binary}`);
      }
      const profileDir = this.webProfileDir();
      mkdirSync(profileDir, { recursive: true });
      cmd = binary;
      args = [
        portFlag,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        spec.url,
      ];
    } else {
      // electron + openfin: launch the desktop binary with the debug port.
      if (!spec.binary) {
        throw new Error(`${spec.type} inspection needs the app's executable path.`);
      }
      cmd = spec.binary;
      args = [portFlag, ...(spec.args ?? [])];
    }

    const { env, removed } = sanitizeChildEnv(process.env);
    if (removed.length > 0) {
      appendInfo(this.deps.channel, `[live] scrubbed env for launch: [${removed.join(', ')}]`);
    }
    appendInfo(this.deps.channel, `[live] spawn ${cmd} ${JSON.stringify(args)}`);
    // detached → process-group leader so signalProcessGroup reaps the whole tree.
    return spawn(cmd, args, { env, detached: true, stdio: 'ignore' });
  }

  /** Per-project (workspace-scoped) persistent Chrome profile dir. Falls back to
   *  a global slot when no folder is open. */
  private webProfileDir(): string {
    const base = this.deps.context.storageUri ?? this.deps.context.globalStorageUri;
    return vscode.Uri.joinPath(base, 'chrome-debug-profile').fsPath;
  }

  /** First pool port that is OS-bindable (nothing — CDP or otherwise — holds it). */
  private async allocatePort(): Promise<number | undefined> {
    for (const p of getCdpPorts()) {
      if (await isPortFree(p)) return p;
    }
    return undefined;
  }

  private async waitForChrome(port: number): Promise<AvailableChrome | undefined> {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const found = await probePorts([port]);
      if (found.length > 0) return found[0];
      if (Date.now() >= deadline) return undefined;
      await delay(PROBE_INTERVAL_MS);
    }
  }

  /**
   * Announce the session — NEUTRAL by design: the launch only ATTACHES the CDP
   * port (registered as the `qa-debug-cdp` MCP), so it's usable by `browser_*`,
   * `qa_pick_element`, or ANY other tool/MCP, in WHATEVER agent the QA is in. We
   * do NOT force a custom agent or auto-send a picker prompt (that narrowed the
   * session to one use). The "Open Chat" button opens chat in the current agent.
   */
  private announceSession(port: number): void {
    void vscode.window
      .showInformationMessage(
        `QA Debug: Live Inspect Session active on CDP debug port ${port} — attached as the ` +
          `qa-debug-cdp MCP (browser_*) and to qa_pick_element. Any tool can attach to port ${port}.`,
        'Open Chat',
        'Open Audit Log',
      )
      .then((sel) => {
        if (sel === 'Open Audit Log') {
          this.deps.channel.show();
        } else if (sel === 'Open Chat') {
          void this.openChat(port);
        }
      });
  }

  /**
   * Open Copilot Chat in the QA's current agent, with a NEUTRAL hint prefilled
   * (isPartialQuery → not auto-sent). `workbench.action.chat.open` needs a query
   * to actually open (an empty `{}` resolves but does nothing). Falls back
   * through a few known chat commands across VS Code builds.
   */
  private async openChat(port: number): Promise<void> {
    // A fill-in TEMPLATE (isPartialQuery → editable, never auto-sent): gives the
    // port context + a placeholder for the QA to write their own request.
    const hint =
      `Live Inspect Session on CDP port ${port} (qa-debug-cdp MCP: browser_*, qa_pick_element) — ` +
      `<Put your prompt for interacting with the MCP>`;
    const attempts: Array<() => Thenable<unknown>> = [
      // Prefer opening INTO our qa-debug-inspect agent; if the mode switch is a
      // no-op on this build, chat still opens and the agent stays selectable
      // from the dropdown (it's contributed `when: qa-debug.liveSession`).
      () =>
        vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
          query: hint,
          isPartialQuery: true,
          mode: 'qa-debug-inspect',
        }),
      () => vscode.commands.executeCommand(CHAT_OPEN_COMMAND, { query: hint, isPartialQuery: true }),
      () => vscode.commands.executeCommand(CHAT_OPEN_COMMAND, hint),
      () => vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus'),
    ];
    for (const run of attempts) {
      try {
        await run();
        return;
      } catch {
        // try the next candidate
      }
    }
    appendInfo(this.deps.channel, '[live] could not open chat (no known chat-open command worked)');
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
