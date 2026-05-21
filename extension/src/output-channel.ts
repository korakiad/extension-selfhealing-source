/**
 * Audit log channel (`vscode.window.createOutputChannel('QA Debug Companion')`).
 * Every decision flows through here per S4_DESIGN.md §3.5 / §8.5.
 *
 * The channel is a singleton owned by the extension activation. The decision
 * row format is intentionally machine-parseable so a future tail tool can
 * extract decision history without ad-hoc regex work.
 */

import * as vscode from 'vscode';

import type { DecisionBy, DecisionKind } from '@qa-debug/mocha-hooks/protocol';

const CHANNEL_NAME = 'QA Debug Companion';

let channelSingleton: vscode.OutputChannel | undefined;

export function createAuditChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (channelSingleton) return channelSingleton;
  const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(channel);
  channelSingleton = channel;
  channel.appendLine(`[activate] qa-debug-companion ready ${new Date().toISOString()}`);
  return channel;
}

export interface DecisionRow {
  sessionId: string;
  testTitle: string;
  decision: DecisionKind;
  by: DecisionBy;
  reasonOrRationale: string;
}

export function appendDecision(channel: vscode.OutputChannel, row: DecisionRow): void {
  const ts = new Date().toISOString();
  const escapedReason = row.reasonOrRationale.replace(/"/g, '\\"');
  channel.appendLine(
    `${ts} session=${row.sessionId} test="${row.testTitle}" decision=${row.decision} by=${row.by} reason="${escapedReason}"`,
  );
}

export function appendInfo(channel: vscode.OutputChannel, message: string): void {
  channel.appendLine(`${new Date().toISOString()} ${message}`);
}
