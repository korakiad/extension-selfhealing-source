/**
 * CdpBinding — the one place a CDP endpoint gets bound to the playwright-mcp
 * gate. Owns the optional download-shim hop: when `qaDebug.cdpDownloadShim.enabled`
 * (default true), the MCP is pointed at the shim's httpRoot instead of the raw
 * endpoint so `Browser.setDownloadBehavior` is swallowed — old Electron /
 * embedded Chromium reject that command and would otherwise fail the attach.
 *
 * Shared by SessionManager (pause flow — bound on chrome selection) and
 * LiveSessionManager (live inspect — bound after the launch probe). Both used
 * to carry a private copy of this logic; behavior differences live at the call
 * sites (what to log, when to setIdle/clearPaused), not here.
 */

import * as vscode from 'vscode';

import { startCdpDownloadShim, type CdpShim } from './cdp-download-shim.js';
import type { QaDebugMcpProvider } from './mcp-provider.js';
import { appendInfo } from './output-channel.js';

/**
 * Convert a CDP WebSocket URL (`ws://host:port` or `ws://host:port/devtools/browser/<UUID>`)
 * to the HTTP root form (`http://host:port`) that `mcpProvider.setPaused` expects.
 *
 * Playwright `connectOverCDP` accepts BOTH ws-with-path and http-root forms
 * (class-browsertype.md), but canonicalizing to http-root lets Playwright
 * re-discover the active target via `/json/version` if the devtools UUID
 * rotates between discovery and connect.
 *
 * Assumes the input uses `ws://` scheme — cdp_ws_url comes from the
 * /json/version probe (mocha-hooks/probe.ts), which keeps the scheme as
 * published by Chrome itself. If remote-chrome `wss://` support is ever added,
 * preserve scheme via `wsUrl.startsWith('wss:') ? 'https' : 'http'`.
 */
export function cdpWsUrlToHttpRoot(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `http://${u.host}`;
}

export class CdpBinding {
  private cdpShim?: CdpShim;

  constructor(
    private readonly mcpProvider: QaDebugMcpProvider,
    private readonly channel: vscode.OutputChannel,
    /** Log-line prefix of the owning manager, e.g. '[session-manager]' or '[live]'. */
    private readonly logPrefix: string,
  ) {}

  /**
   * Start the download-shim (if enabled) and point the MCP at it; otherwise
   * publish the raw endpoint. Replacing a binding tears down the prior shim
   * first. A shim start failure is non-fatal — falls back to the raw endpoint.
   *
   * `detail` is appended to the bound log line (call-site context: port,
   * selection source, session id).
   */
  async bindMcp(wsUrl: string, detail = ''): Promise<void> {
    const rawHttpRoot = cdpWsUrlToHttpRoot(wsUrl);
    await this.stopShim();

    const shimEnabled = vscode.workspace
      .getConfiguration('qaDebug')
      .get<boolean>('cdpDownloadShim.enabled', true);

    let endpoint = rawHttpRoot;
    if (shimEnabled) {
      try {
        this.cdpShim = await startCdpDownloadShim({
          targetHttpRoot: rawHttpRoot,
          log: (msg) => appendInfo(this.channel, msg),
        });
        endpoint = this.cdpShim.httpRoot;
      } catch (err) {
        appendInfo(
          this.channel,
          `${this.logPrefix} WARN cdp-shim failed to start (${(err as Error).message}); ` +
            `falling back to raw endpoint ${rawHttpRoot}`,
        );
      }
    }

    this.mcpProvider.setPaused(endpoint);
    appendInfo(
      this.channel,
      `${this.logPrefix} mcpProvider.setPaused endpoint=${endpoint} ` +
        `(raw=${rawHttpRoot}, shim=${this.cdpShim ? 'on' : 'off'})${detail}`,
    );
  }

  /** Stop and clear the active shim (idempotent). Does NOT touch the MCP gate —
   *  the owner decides between setIdle (pause/session over) and clearPaused
   *  (selection invalidated). */
  async stopShim(): Promise<void> {
    const shim = this.cdpShim;
    if (!shim) return;
    this.cdpShim = undefined;
    try {
      await shim.stop();
    } catch (err) {
      appendInfo(
        this.channel,
        `${this.logPrefix} WARN cdp-shim stop error: ${(err as Error).message}`,
      );
    }
  }
}
