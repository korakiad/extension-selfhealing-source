/**
 * TestRail credential plumbing (PLAN-testrail D5/D8).
 *
 * URL + username + API key all live in SecretStorage — the instance hostname
 * is itself company-internal, so nothing TestRail-related syncs via settings
 * (no qaDebug.testrail.* keys under contributes.configuration). The QA
 * configures via the "QA Debug: Configure TestRail" palette command; tools
 * called before that throw TESTRAIL_NOT_CONFIGURED.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { TestRailClient } from './client.js';

const KEY_URL = 'qaDebug.testrail.url';
const KEY_USERNAME = 'qaDebug.testrail.username';
const KEY_API_KEY = 'qaDebug.testrail.apiKey';
const ALL_KEYS = [KEY_URL, KEY_USERNAME, KEY_API_KEY] as const;

export interface TestRailStoredConfig {
  baseUrl: string;
  username: string;
  apiKey: string;
}

/** Strips trailing slashes and a trailing index.php(?…) from user input so the
 *  client's `{base}/index.php?/api/v2/` composition never doubles up. */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  url = url.replace(/\/?index\.php.*$/i, '');
  url = url.replace(/\/+$/, '');
  return url;
}

export class TestRailService {
  private client: TestRailClient | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (line: string) => void,
    subscriptions: { dispose(): void }[],
  ) {
    // Cache invalidation: any write to our keys (this window or another)
    // drops the cached client; the next tool call rebuilds from storage.
    subscriptions.push(
      secrets.onDidChange((e) => {
        if ((ALL_KEYS as readonly string[]).includes(e.key)) this.client = undefined;
      }),
    );
  }

  async getStoredConfig(): Promise<TestRailStoredConfig | undefined> {
    const [baseUrl, username, apiKey] = await Promise.all(
      ALL_KEYS.map((k) => this.secrets.get(k)),
    );
    if (!baseUrl || !username || !apiKey) return undefined;
    return { baseUrl, username, apiKey };
  }

  async setStoredConfig(cfg: TestRailStoredConfig): Promise<void> {
    await this.secrets.store(KEY_URL, normalizeBaseUrl(cfg.baseUrl));
    await this.secrets.store(KEY_USERNAME, cfg.username);
    await this.secrets.store(KEY_API_KEY, cfg.apiKey);
    this.client = undefined;
  }

  async clearStoredConfig(): Promise<void> {
    await Promise.all(ALL_KEYS.map((k) => this.secrets.delete(k)));
    this.client = undefined;
  }

  /** Throws TESTRAIL_NOT_CONFIGURED with the exact command name the agent is
   *  instructed to relay verbatim. */
  async getClient(): Promise<TestRailClient> {
    if (this.client) return this.client;
    const cfg = await this.getStoredConfig();
    if (!cfg) {
      throw new QaToolError(
        'TESTRAIL_NOT_CONFIGURED',
        'TestRail is not configured — ask the user to run "QA Debug: Configure TestRail" from the Command Palette.',
      );
    }
    this.client = new TestRailClient(cfg, {
      log: this.log,
      attachmentsDir: getAttachmentsDir,
    });
    return this.client;
  }
}

/** First workspace folder hosts .qa-debug/ (PLAN-testrail D4, stated not
 *  implied). Throws NO_WORKSPACE when no folder is open. */
export function getAttachmentsDir(): string {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders?.find((f) => f.uri.scheme === 'file');
  if (!root) {
    throw new QaToolError('NO_WORKSPACE', 'open a workspace folder first — attachment files are saved under .qa-debug/attachments/');
  }
  return path.join(root.uri.fsPath, '.qa-debug', 'attachments');
}
