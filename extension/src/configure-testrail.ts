/**
 * "QA Debug: Configure TestRail" — the one transparent-use entry point for
 * TestRail credentials (PLAN-testrail D5). Three masked-where-needed input
 * boxes → SecretStorage → a verification call through the real client+parser
 * so the QA learns immediately whether the gateway-prefix handling works
 * against their instance. Works without a workspace (credentials are global).
 */

import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { appendInfo } from './output-channel.js';
import { normalizeBaseUrl, TestRailService } from './testrail/config.js';

const CLEAR_ITEM = '$(trash) Clear stored TestRail credentials';
const CONFIGURE_ITEM = '$(key) Configure / update credentials';

export function registerConfigureTestRail(
  context: vscode.ExtensionContext,
  service: TestRailService,
  channel: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.configureTestRail', async () => {
      const existing = await service.getStoredConfig();
      if (existing) {
        const pick = await vscode.window.showQuickPick([CONFIGURE_ITEM, CLEAR_ITEM], {
          title: 'QA Debug: Configure TestRail',
          placeHolder: `Configured for ${existing.username}`,
        });
        if (!pick) return;
        if (pick === CLEAR_ITEM) {
          await service.clearStoredConfig();
          appendInfo(channel, '[testrail] stored credentials cleared');
          void vscode.window.showInformationMessage('QA Debug: TestRail credentials cleared.');
          return;
        }
      }

      const url = await vscode.window.showInputBox({
        title: 'TestRail instance URL (1/3)',
        prompt: 'e.g. https://testrail.your-company.com — stored in VS Code secret storage, never in settings',
        value: existing?.baseUrl ?? '',
        ignoreFocusOut: true,
        validateInput: (v) =>
          /^https?:\/\/\S+$/i.test(normalizeBaseUrl(v)) ? undefined : 'Enter a full http(s):// URL',
      });
      if (!url) return;

      const username = await vscode.window.showInputBox({
        title: 'TestRail username (2/3)',
        prompt: 'Usually your company e-mail address',
        value: existing?.username ?? '',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length > 0 ? undefined : 'Username is required'),
      });
      if (!username) return;

      const apiKey = await vscode.window.showInputBox({
        title: 'TestRail API key (3/3)',
        prompt: 'Create one in TestRail under My Settings > API Keys (your password also works, but a key is revocable)',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length > 0 ? undefined : 'API key is required'),
      });
      if (!apiKey) return;

      await service.setStoredConfig({
        baseUrl: url,
        username: username.trim(),
        apiKey: apiKey.trim(),
      });

      // Verification through the real client+parser. Bare get_current_user
      // first; the official doc ambiguously lists a user_id path param and
      // gates it at TestRail 6.6+ — fall back to get_projects&limit=1 on
      // 400/404 so a doc quirk doesn't fail a healthy instance.
      const verdict = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'QA Debug: verifying TestRail connection…' },
        () => verifyConnection(service),
      );
      if (verdict.ok) {
        appendInfo(channel, `[testrail] configured + verified (${verdict.summary}; gateway prefix detected: ${verdict.hadPrefix})`);
        void vscode.window.showInformationMessage(`QA Debug: TestRail connected — ${verdict.summary}.`);
      } else {
        appendInfo(channel, `[testrail] verification failed: ${verdict.error}`);
        const retry = await vscode.window.showErrorMessage(
          `QA Debug: TestRail verification failed — ${verdict.error}`,
          'Edit settings',
        );
        if (retry) void vscode.commands.executeCommand('qa-debug.configureTestRail');
      }
    }),
  );
}

async function verifyConnection(
  service: TestRailService,
): Promise<{ ok: true; summary: string; hadPrefix: boolean } | { ok: false; error: string }> {
  try {
    const client = await service.getClient();
    try {
      const me = await client.getJson('get_current_user');
      const name = (me.data as { name?: string; email?: string } | null)?.name
        ?? (me.data as { email?: string } | null)?.email
        ?? 'user verified';
      return { ok: true, summary: String(name), hadPrefix: me.hadPrefix };
    } catch (err) {
      if (err instanceof QaToolError && (err.code === 'BAD_REQUEST' || err.code === 'ENDPOINT_NOT_FOUND')) {
        const projects = await client.getJson('get_projects&limit=1');
        const size = (projects.data as { size?: number } | null)?.size;
        return {
          ok: true,
          summary: typeof size === 'number' ? `instance reachable (${size}+ project${size === 1 ? '' : 's'} visible)` : 'instance reachable',
          hadPrefix: projects.hadPrefix,
        };
      }
      throw err;
    }
  } catch (err) {
    const msg = err instanceof QaToolError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
