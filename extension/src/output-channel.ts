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
const MOCHA_CHANNEL_NAME = 'QA Debug Mocha';

let channelSingleton: vscode.OutputChannel | undefined;
let mochaChannelSingleton: vscode.OutputChannel | undefined;

export function createAuditChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (channelSingleton) return channelSingleton;
  const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(channel);
  channelSingleton = channel;
  channel.appendLine(`[activate] qa-debug-companion ready ${new Date().toISOString()}`);
  return channel;
}

/**
 * Raw mocha child stdout/stderr land here so the QA can see why their tests
 * stall (config errors, console.log from specs, qa-reporter output, qa-hooks
 * stderr breadcrumbs). The audit channel stays machine-parseable; this one
 * carries human-facing log soup.
 */
export function createMochaChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (mochaChannelSingleton) return mochaChannelSingleton;
  const channel = vscode.window.createOutputChannel(MOCHA_CHANNEL_NAME);
  context.subscriptions.push(channel);
  mochaChannelSingleton = channel;
  return channel;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function createChildLogPump(
  channel: vscode.OutputChannel,
  stream: 'stdout' | 'stderr',
): (chunk: Buffer | string) => void {
  let buf = '';
  const prefix = stream === 'stderr' ? '[stderr] ' : '';
  return (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '').replace(ANSI_RE, '');
      channel.appendLine(`${prefix}${line}`);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  };
}

export type AuditDecisionKind = DecisionKind;
export type AuditDecisionBy = DecisionBy;

export interface DecisionRow {
  sessionId: string;
  testTitle: string;
  decision: AuditDecisionKind;
  by: AuditDecisionBy;
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
