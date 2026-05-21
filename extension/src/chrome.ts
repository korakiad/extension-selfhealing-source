/**
 * Headed Chrome lifecycle owned by the extension per S4_DESIGN.md §6.3.
 *
 * Chrome is spawned with `--remote-debugging-port=9222` on Mocha *suite start*
 * (not on extension activation). Reused across tests within a suite invocation.
 * Survives mocha child respawn for retry (extension owns Chrome independently
 * of mocha lifecycle). Torn down on mocha clean exit when no pause is outstanding,
 * or on extension deactivate.
 *
 * Chrome-binary discovery uses CHROME_PATH env var if set, else falls back to
 * platform-specific known locations. If discovery fails, the spawn surfaces a
 * showErrorMessage and the suite-run aborts cleanly.
 *
 * Chrome crash recovery is out of scope per S4_DESIGN.md §6.3 NB#6 — the
 * extension null-checks Chrome on the next suite invocation and respawns
 * lazily; mid-pause auto-relaunch is Phase 2.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

import type { OutputChannel } from 'vscode';

import { appendInfo } from './output-channel.js';

const CDP_PORT = 9222;

const PLATFORM_CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

function findChromeBinary(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = PLATFORM_CHROME_PATHS[process.platform] ?? [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export class ChromeProcess {
  private child?: ChildProcess;
  private userDataDir?: string;

  constructor(private readonly auditChannel: OutputChannel) {}

  /** Idempotent: returns immediately if already running. */
  async spawn(): Promise<void> {
    if (this.child && !this.child.killed) {
      appendInfo(this.auditChannel, `[chrome] reuse pid=${this.child.pid}`);
      return;
    }
    const binary = findChromeBinary();
    if (!binary) {
      const msg = `Could not locate Chrome binary. Set CHROME_PATH env var or install Chrome at a default location.`;
      void vscode.window.showErrorMessage(`QA Debug: ${msg}`);
      throw new Error(msg);
    }
    this.userDataDir = join(tmpdir(), `qa-debug-chrome-${Date.now()}`);
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    this.child = spawn(binary, args, { stdio: 'ignore', detached: false });
    appendInfo(this.auditChannel, `[chrome] spawned pid=${this.child.pid} port=${CDP_PORT}`);
    this.child.on('exit', (code, signal) => {
      appendInfo(this.auditChannel, `[chrome] exited code=${code} signal=${signal}`);
      this.child = undefined;
    });
    // Wait briefly for the DevTools HTTP endpoint to come up; bounded.
    await this.waitForCdp();
  }

  private async waitForCdp(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        if (response.ok) return;
      } catch {
        // not yet ready; retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    appendInfo(
      this.auditChannel,
      `[chrome] CDP endpoint at :${CDP_PORT} did not respond within ${timeoutMs}ms — proceeding anyway`,
    );
  }

  isAlive(): boolean {
    return !!this.child && !this.child.killed;
  }

  /** Tear down Chrome. Idempotent. */
  async dispose(): Promise<void> {
    if (!this.child || this.child.killed) {
      this.child = undefined;
      return;
    }
    appendInfo(this.auditChannel, `[chrome] tearing down pid=${this.child.pid}`);
    this.child.kill('SIGTERM');
    // Give Chrome a short window to exit gracefully; SIGKILL if needed.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child?.kill('SIGKILL');
        resolve();
      }, 2000);
      this.child!.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.child = undefined;
  }

  /** HTTP endpoint form for playwright-mcp `--cdp-endpoint`. */
  get cdpHttpEndpoint(): string {
    return `http://localhost:${CDP_PORT}`;
  }

  /** WS form for the hook's pause payload. Playwright clients discover WS from HTTP. */
  get cdpWsEndpoint(): string {
    return `ws://localhost:${CDP_PORT}`;
  }
}
